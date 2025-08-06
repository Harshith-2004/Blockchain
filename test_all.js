// test_all.js
// Run with: node test_all.js
// Dependencies: ethers@5, solc

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // ─── 1) Compile all contracts ────────────────────────────────────────────────
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
    if (!fs.existsSync(f)) throw new Error(`Missing ${f}`);
    sources[f] = fs.readFileSync(f, "utf8");
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([fn,content])=>[fn,{ content }])),
    settings: { outputSelection: { "*": { "*": ["abi","evm.bytecode"] } } }
  };
  function findImports(path) {
    const key = path.replace("./","");
    return sources[key] ? { contents: sources[key] } : { error: "File not found" };
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) {
    for (const e of output.errors) {
      if (e.severity === "error") throw new Error(e.formattedMessage);
    }
  }
  const C = (name, file) => output.contracts[file][name];

  // ─── 2) Provider & Signers ──────────────────────────────────────────────────
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accounts = await provider.listAccounts();
  if (accounts.length < 4) throw new Error("Need 4 accounts");
  const [admin, patient, doctor, insurer] = accounts;
  const aS = provider.getSigner(admin);
  const pS = provider.getSigner(patient);
  const dS = provider.getSigner(doctor);
  const iS = provider.getSigner(insurer);

  // ─── 3) Deploy TestToken & Distribute ──────────────────────────────────────
  const Token = await new ethers.ContractFactory(
    C("TestToken","TestToken.sol").abi,
    C("TestToken","TestToken.sol").evm.bytecode.object,
    aS
  ).deploy();
  await Token.deployed();
  const INIT = ethers.utils.parseEther("1000");
  for (let who of [patient, doctor, insurer]) {
    await Token.transfer(who, INIT);
  }

  // ─── 4) Deploy Registries & Pool ───────────────────────────────────────────
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
  await insReg.setPolicy(patient, insurer, 100);

  const pool = await new ethers.ContractFactory(
    C("InsurancePool","InsurancePool.sol").abi,
    C("InsurancePool","InsurancePool.sol").evm.bytecode.object,
    aS
  ).deploy(Token.address, 150);
  await pool.deployed();

  console.log("✅ Contracts deployed");

  // ─── 5) Reserve & Premium Flows ────────────────────────────────────────────
  await Token.connect(iS).approve(pool.address, INIT);
  let reverted = false;
  try { await pool.connect(iS).seedReserve(0) } catch(e) { reverted = /amount>0/.test(e.message) }
  if (!reverted) throw new Error("seedReserve(0) did not revert");
  const seedAmt = ethers.utils.parseEther("500");
  await pool.connect(iS).seedReserve(seedAmt);
  console.log("  • Insurer seeded reserve");

  await Token.connect(pS).approve(pool.address, INIT);
  reverted = false;
  try { await pool.connect(pS).payPremium(insurer, 0) } catch(e) { reverted = /amount>0/.test(e.message) }
  if (!reverted) throw new Error("payPremium(0) did not revert");
  const premAmt = ethers.utils.parseEther("100");
  await pool.connect(pS).payPremium(insurer, premAmt);
  console.log("  • Patient paid premium");

  // ─── 6) Deploy ClaimEscrow & Setup ─────────────────────────────────────────
  const claimEsc = await new ethers.ContractFactory(
    C("ClaimEscrow","ClaimEscrow.sol").abi,
    C("ClaimEscrow","ClaimEscrow.sol").evm.bytecode.object,
    aS
  ).deploy(Token.address, docReg.address, appt.address, insReg.address, pool.address);
  await claimEsc.deployed();
  await docReg.addDoctor(doctor);
  await appt.connect(pS).requestAppointment(doctor);
  await appt.connect(dS).confirmAppointment(patient);
  console.log("  • Doctor registered & OP consent granted");

  // ─── 7) Over-capacity check ─────────────────────────────────────────────────
  await Token.connect(iS).approve(claimEsc.address, ethers.utils.parseEther("410"));
  await Token.connect(pS).approve(claimEsc.address, ethers.utils.parseEther("500"));
  await Token.connect(dS).approve(claimEsc.address, ethers.utils.parseEther("500"));
  reverted = false;
  try {
    await claimEsc.connect(pS).initiateClaim(doctor, ethers.utils.parseEther("410"), false);
  } catch(e) {
    reverted = /Insufficient reserve/.test(e.message);
  }
  if (!reverted) throw new Error("Over-capacity claim did not revert");
  console.log("  • Over-capacity claim blocked");

  // ─── 8) Top up & Normal flow ───────────────────────────────────────────────
  const topUp = ethers.utils.parseEther("300");
  await Token.connect(iS).approve(pool.address, topUp);
  await pool.connect(iS).topUpReserve(topUp);
  console.log("  • Insurer topped up reserve");

  const claimAmt = ethers.utils.parseEther("200");
  await Token.connect(pS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  await Token.connect(dS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  await Token.connect(iS).approve(claimEsc.address, claimAmt);
  await claimEsc.connect(pS).initiateClaim(doctor, claimAmt, false);
  console.log("  • initiateClaim");

  await claimEsc.releaseInitial(0);
  console.log("  • releaseInitial");

  await provider.send("evm_increaseTime",[31*24*3600]);
  await provider.send("evm_mine");

  const beforePat = await Token.balanceOf(patient);
  await claimEsc.completeClaim(0);
  const afterPat  = await Token.balanceOf(patient);
  if (!afterPat.sub(beforePat).eq(claimAmt.mul(50).div(100))) throw new Error("Patient stake not returned");
  console.log("  • completeClaim & stake returned");
  await Token.connect(aS).transfer(insurer, claimAmt);
  console.log("  • Insurer balance topped up for second claim");
  // ─── 9) Dispute Flow ───────────────────────────────────────────────────────
  await provider.send("evm_increaseTime",[-31*24*3600]);
  await provider.send("evm_mine");

  // restake & reinitiate
  await Token.connect(pS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  await Token.connect(dS).approve(claimEsc.address, claimAmt.mul(50).div(100));
  await Token.connect(iS).approve(claimEsc.address, claimAmt);
  await claimEsc.connect(pS).initiateClaim(doctor, claimAmt, false);
  await claimEsc.releaseInitial(1);
  console.log("  • second initiate & release");

  // capture balances
  const beforeIns = await Token.balanceOf(insurer);
  console.log("    ▶ insurer before dispute:", beforeIns.toString());

  await claimEsc.connect(iS).disputeClaim(1);
  console.log("  • disputeClaim");

  const afterIns  = await Token.balanceOf(insurer);
  console.log("    ▶ insurer after dispute: ", afterIns.toString());

  // ─── UPDATED ASSERTION ──────────────────────────────────────────────────────
  // fetch on-chain stakes for claim #1
  const stored = await claimEsc.claims(1);
  const expectedSlash = stored.patientStake.add(stored.doctorStake);

  if (!afterIns.sub(beforeIns).eq(expectedSlash)) {
    throw new Error(
      `Insurer slashed amount incorrect: expected ${expectedSlash.toString()}, got ${afterIns.sub(beforeIns).toString()}`
    );
  }
  console.log("  • slashes paid to insurer");

  // reputation check
  const patPct = await claimEsc.getPatientPct(patient);
  if (patPct.toNumber() !== 65) throw new Error("Patient pct not penalized correctly");
  console.log("  • reputation updated");

  console.log("\n🎉 All scenarios passed!");
}

main().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
