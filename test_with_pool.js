// test_with_pool.js
// Dependencies: ethers@5, solc
// Usage: node test_with_pool.js

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // 1) Compile all contracts
  const files = [
    "IERC20.sol",
    "TestToken.sol",
    "DoctorRegistry.sol",
    "AppointmentManager.sol",
    "InsuranceRegistry.sol",
    "InsurancePool.sol",
    "ClaimEscrow.sol"
  ];
  const sources = {};
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`${f} missing`);
    sources[f] = fs.readFileSync(f, "utf8");
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([fn,content])=>[fn,{content}])),
    settings: { outputSelection: { "*": { "*": ["abi","evm.bytecode"] } } }
  };
  function findImports(path) {
    const key = path.replace("./","");
    return sources[key]? { contents: sources[key] } : { error: "not found" };
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) for (const e of output.errors) if(e.severity==="error") throw new Error(e.formattedMessage);
  const C = (name,f) => output.contracts[f][name];

  // 2) Setup provider & signers
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const [admin, patient, doctor, insurer] = await provider.listAccounts();
  const aS = provider.getSigner(admin);
  const pS = provider.getSigner(patient);
  const dS = provider.getSigner(doctor);
  const iS = provider.getSigner(insurer);

  // 3) Deploy TestToken & distribute
  const Token = await new ethers.ContractFactory(
    C("TestToken","TestToken.sol").abi,
    C("TestToken","TestToken.sol").evm.bytecode.object,
    aS
  ).deploy();
  await Token.deployed();
  const initBal = ethers.utils.parseEther("1000");
  await Token.connect(aS).transfer(patient, initBal);
  await Token.connect(aS).transfer(doctor,  initBal);
  await Token.connect(aS).transfer(insurer, initBal);

  // 4) Deploy registries & pool
  const docReg = await new ethers.ContractFactory(
    C("DoctorRegistry","DoctorRegistry.sol").abi,
    C("DoctorRegistry","DoctorRegistry.sol").evm.bytecode.object,
    aS
  ).deploy();
  const appt   = await new ethers.ContractFactory(
    C("AppointmentManager","AppointmentManager.sol").abi,
    C("AppointmentManager","AppointmentManager.sol").evm.bytecode.object,
    aS
  ).deploy(docReg.address);
  const insReg = await new ethers.ContractFactory(
    C("InsuranceRegistry","InsuranceRegistry.sol").abi,
    C("InsuranceRegistry","InsuranceRegistry.sol").evm.bytecode.object,
    aS
  ).deploy();
  // set patient-insurer policy 100%
  await insReg.connect(aS).setPolicy(patient, insurer, 100);

  const pool = await new ethers.ContractFactory(
    C("InsurancePool","InsurancePool.sol").abi,
    C("InsurancePool","InsurancePool.sol").evm.bytecode.object,
    aS
  ).deploy(Token.address, 150); // 150% min reserve
  await pool.deployed();

  // 5) Insurer seeds reserve & patient pays premium
  const seedAmt = ethers.utils.parseEther("500");
  await Token.connect(iS).approve(pool.address, seedAmt);
  await pool.connect(iS).seedReserve(seedAmt);

  const premAmt = ethers.utils.parseEther("100");
  await Token.connect(pS).approve(pool.address, premAmt);
  await pool.connect(pS).payPremium(insurer, premAmt);

  // 6) Deploy ClaimEscrow
  const claimEsc = await new ethers.ContractFactory(
    C("ClaimEscrow","ClaimEscrow.sol").abi,
    C("ClaimEscrow","ClaimEscrow.sol").evm.bytecode.object,
    aS
  ).deploy(Token.address, docReg.address, appt.address, insReg.address, pool.address);
  await claimEsc.deployed();

  // 7) Doctor registration & OP consent
  await docReg.connect(aS).addDoctor(doctor);
  await appt.connect(pS).requestAppointment(doctor);
  await appt.connect(dS).confirmAppointment(patient);

  // 8) Patient & doctor approve stakes; insurer’s deposit is in `pool`
  const claimAmt = ethers.utils.parseEther("100");
  // patient stakes 50%, doctor stakes 50%
  await Token.connect(pS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  await Token.connect(dS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  // ─── **NEW: insurer must also approve ClaimEscrow** ─────────────────────────
  await Token.connect(iS).approve(claimEsc.address, claimAmt);

  // initiate claim
  await claimEsc.connect(pS).initiateClaim(doctor, claimAmt, false);

  // 9) Initial release
  await claimEsc.releaseInitial(0);

  // 10) Move time past review
  await provider.send("evm_increaseTime",[31*24*3600]); 
  await provider.send("evm_mine");
  // patient balance before
  const beforePat = await Token.balanceOf(patient);
  await claimEsc.completeClaim(0);
  const afterPat  = await Token.balanceOf(patient);
  // patient gets back 50% stake
  if (!afterPat.sub(beforePat).eq(claimAmt.mul(50).div(100))) {
    throw new Error("Patient stake not returned");
  }

  console.log("🎉 All tests with InsurancePool passed!");
}

main().catch(e=>{
  console.error("❌ Test failed:",e);
  process.exit(1);
});
