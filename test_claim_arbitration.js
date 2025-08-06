// test_claim_arbitration.js
// Dependencies: ethers@5, solc
// Usage: node test_claim_arbitration.js

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // 1) Compile
  const files = [
    "InsurancePool.sol",
    "IERC20.sol",
    "TestToken.sol",
    "DoctorRegistry.sol",
    "AppointmentManager.sol",
    "InsuranceRegistry.sol",
    "ClaimEscrow.sol"
  ];
  const sources = {};
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`${f} not found`);
    sources[f] = fs.readFileSync(f, "utf8");
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      Object.entries(sources).map(([fn, content]) => [fn, { content }])
    ),
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } }
  };
  function findImports(path) {
    const key = path.replace("./", "");
    return sources[key] ? { contents: sources[key] } : { error: "File not found" };
  }
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );
  if (output.errors) {
    for (const e of output.errors) {
      if (e.severity === "error") throw new Error(e.formattedMessage);
    }
  }
  const C = (name, file) => output.contracts[file][name];

  // 2) Setup provider & signers
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accounts = await provider.listAccounts();
  if (accounts.length < 4) throw new Error("Need at least 4 accounts");
  const [admin, patient, doctor, insurer] = accounts;
  const adminSigner   = provider.getSigner(admin);
  const patientSigner = provider.getSigner(patient);
  const doctorSigner  = provider.getSigner(doctor);
  const insurerSigner = provider.getSigner(insurer);

  // 3) Deploy TestToken & fund
  const Token = await new ethers.ContractFactory(
    C("TestToken", "TestToken.sol").abi,
    C("TestToken", "TestToken.sol").evm.bytecode.object,
    adminSigner
  ).deploy();
  await Token.deployed();

  const initial = ethers.utils.parseEther("1000");
  for (const a of [patient, doctor, insurer]) {
    await Token.connect(adminSigner).transfer(a, initial);
  }

  // 4) Deploy registries + AppointmentManager
  const docReg = await new ethers.ContractFactory(
    C("DoctorRegistry", "DoctorRegistry.sol").abi,
    C("DoctorRegistry", "DoctorRegistry.sol").evm.bytecode.object,
    adminSigner
  ).deploy();
  await docReg.deployed();

  const apptMgr = await new ethers.ContractFactory(
    C("AppointmentManager", "AppointmentManager.sol").abi,
    C("AppointmentManager", "AppointmentManager.sol").evm.bytecode.object,
    adminSigner
  ).deploy(docReg.address);
  await apptMgr.deployed();

  const insReg = await new ethers.ContractFactory(
    C("InsuranceRegistry", "InsuranceRegistry.sol").abi,
    C("InsuranceRegistry", "InsuranceRegistry.sol").evm.bytecode.object,
    adminSigner
  ).deploy();
  await insReg.deployed();

  // 5) Deploy InsurancePool
  const pool = await new ethers.ContractFactory(
    C("InsurancePool", "InsurancePool.sol").abi,
    C("InsurancePool", "InsurancePool.sol").evm.bytecode.object,
    adminSigner
  ).deploy(Token.address, 150);
  await pool.deployed();

  // ─── Seed just enough to cover 150% of a 100-TST claim ────────────────────
  const reserveAmt = ethers.utils.parseEther("150");  // 150 TST for a 100 TST claim
  await Token.connect(insurerSigner).approve(pool.address, reserveAmt);
  await pool.connect(insurerSigner).seedReserve(reserveAmt);

  // 6) Set policy & deploy ClaimEscrow
  await insReg.connect(adminSigner).setPolicy(patient, insurer, 100);
  const claimEsc = await new ethers.ContractFactory(
    C("ClaimEscrow", "ClaimEscrow.sol").abi,
    C("ClaimEscrow", "ClaimEscrow.sol").evm.bytecode.object,
    adminSigner
  ).deploy(
    Token.address,
    docReg.address,
    apptMgr.address,
    insReg.address,
    pool.address
  );
  await claimEsc.deployed();

  // 7) Doctor + OP consent
  await docReg.connect(adminSigner).addDoctor(doctor);
  await apptMgr.connect(patientSigner).requestAppointment(doctor);
  await apptMgr.connect(doctorSigner).confirmAppointment(patient);
  console.log("✅ Doctor registered & OP consent granted");

  // 8) Basic flow
  const claimAmt = ethers.utils.parseEther("100");
  await Token.connect(patientSigner).approve(
    claimEsc.address,
    claimAmt.mul(50).div(100)
  );
  await Token.connect(doctorSigner).approve(
    claimEsc.address,
    claimAmt.mul(50).div(100)
  );
  await Token.connect(insurerSigner).approve(
    claimEsc.address,
    claimAmt
  );

  // 8.1 initiateClaim
  await claimEsc.connect(patientSigner).initiateClaim(
    doctor,
    claimAmt,
    false
  );
  console.log("✅ initiateClaim");

  // 8.2 releaseInitial
  const balDoc0 = await Token.balanceOf(doctor);
  await claimEsc.releaseInitial(0);
  const balDoc1 = await Token.balanceOf(doctor);
  if (!balDoc1.sub(balDoc0).eq(claimAmt)) {
    throw new Error("releaseInitial failed");
  }
  console.log("✅ releaseInitial works");

  // 8.3 completeClaim
  await provider.send("evm_increaseTime", [31 * 24 * 3600]);
  await provider.send("evm_mine");
  const balPat0 = await Token.balanceOf(patient);
  await claimEsc.completeClaim(0);
  const balPat1 = await Token.balanceOf(patient);
  if (!balPat1.sub(balPat0).eq(claimAmt.mul(50).div(100))) {
    throw new Error("completeClaim did not return stake");
  }
  console.log("✅ completeClaim returns stake");

  // 8.4 unauthorized initiateClaim
  let threw = false;
  try {
    await claimEsc.connect(doctorSigner).initiateClaim(
      doctor,
      claimAmt,
      false
    );
  } catch (e) {
    threw = /No OP auth/.test(e.error?.message || e.message);
  }
  if (!threw) throw new Error("unauthorized initiateClaim allowed");
  console.log("✅ unauthorized blocked");

  // 9) Dispute flow
  // New claim id=1
  const patPct = await claimEsc.getPatientPct(patient);
  const docPct = await claimEsc.getDoctorPct(doctor);

  await provider.send("evm_increaseTime", [-31 * 24 * 3600]);
  await provider.send("evm_mine");

  await Token.connect(patientSigner).approve(
    claimEsc.address,
    claimAmt.mul(50).div(100)
  );
  await Token.connect(doctorSigner).approve(
    claimEsc.address,
    claimAmt.mul(50).div(100)
  );
  await Token.connect(insurerSigner).approve(
    claimEsc.address,
    claimAmt
  );

  await claimEsc.connect(patientSigner).initiateClaim(
    doctor,
    claimAmt,
    false
  );
  await claimEsc.releaseInitial(1);

  // 9.1 disputeClaim
  const slashPct = patPct.add(docPct);
  const slashAmt = claimAmt.mul(slashPct).div(100);
  const balInsBefore = await Token.balanceOf(insurer);
  await claimEsc.connect(insurerSigner).disputeClaim(1);
  const balInsAfter = await Token.balanceOf(insurer);
  if (!balInsAfter.sub(balInsBefore).eq(slashAmt)) {
    throw new Error(
      `Insurer slash incorrect: got ${balInsAfter
        .sub(balInsBefore)
        .toString()}, want ${slashAmt.toString()}`
    );
  }
  console.log("✅ disputeClaim slashes stakes");

  console.log("\n🎉 All tests passed!");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
