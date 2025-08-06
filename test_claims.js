// test_claims.js
// Dependencies: ethers@5, solc
// Usage: node test_claims.js

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // 1) Load & compile all contracts
  const files = [
    "IERC20.sol",
    "TestToken.sol",
    "DoctorRegistry.sol",
    "AppointmentManager.sol",
    "PatientWallet.sol",
    "MedicalRecordManager.sol",
    "InsuranceRegistry.sol",
    "InsurancePool.sol",        // Added
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
    settings: { outputSelection: { "*": { "*": ["abi","evm.bytecode"] } } }
  };
  function findImports(path) {
    const key = path.replace("./", "");
    return sources[key]
      ? { contents: sources[key] }
      : { error: "File not found" };
  }
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );
  if (output.errors) {
    for (const e of output.errors) {
      if (e.severity === "error") throw new Error(e.formattedMessage);
    }
  }
  const C = (name,f) => output.contracts[f][name];

  // 2) Provider & signers
  const provider      = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accounts      = await provider.listAccounts();
  const [admin, patient, doctor, insurer] = accounts;
  const adminSigner   = provider.getSigner(admin);
  const patientSigner = provider.getSigner(patient);
  const doctorSigner  = provider.getSigner(doctor);
  const insurerSigner = provider.getSigner(insurer);

  // 3) Deploy TestToken & fund parties
  const Token = await new ethers.ContractFactory(
    C('TestToken','TestToken.sol').abi,
    C('TestToken','TestToken.sol').evm.bytecode.object,
    adminSigner
  ).deploy();
  await Token.deployed();
  const initial = ethers.utils.parseEther("1000");
  await Token.connect(adminSigner).transfer(patient, initial);
  await Token.connect(adminSigner).transfer(doctor,  initial);
  await Token.connect(adminSigner).transfer(insurer, initial);
  console.log("✅ Distributed 1000 TST to patient, doctor, insurer");

  // 4) Deploy registries & managers
  const registry  = await new ethers.ContractFactory(
    C('DoctorRegistry','DoctorRegistry.sol').abi,
    C('DoctorRegistry','DoctorRegistry.sol').evm.bytecode.object,
    adminSigner
  ).deploy();
  await registry.deployed();

  const apptMgr   = await new ethers.ContractFactory(
    C('AppointmentManager','AppointmentManager.sol').abi,
    C('AppointmentManager','AppointmentManager.sol').evm.bytecode.object,
    adminSigner
  ).deploy(registry.address);
  await apptMgr.deployed();

  const mrm       = await new ethers.ContractFactory(
    C('MedicalRecordManager','MedicalRecordManager.sol').abi,
    C('MedicalRecordManager','MedicalRecordManager.sol').evm.bytecode.object,
    adminSigner
  ).deploy(registry.address, apptMgr.address);
  await mrm.deployed();

  const insurance = await new ethers.ContractFactory(
    C('InsuranceRegistry','InsuranceRegistry.sol').abi,
    C('InsuranceRegistry','InsuranceRegistry.sol').evm.bytecode.object,
    adminSigner
  ).deploy();
  await insurance.deployed();

  // 5) Deploy InsurancePool (required by ClaimEscrow)
  const pool = await new ethers.ContractFactory(
    C('InsurancePool','InsurancePool.sol').abi,
    C('InsurancePool','InsurancePool.sol').evm.bytecode.object,
    adminSigner
  ).deploy(Token.address, 150);
  await pool.deployed();
  console.log("✅ InsurancePool deployed");

  // --- SEED RESERVE so claims can proceed
  const reserveAmt = ethers.utils.parseEther("150");  // cover 150% of a 100-TST claim
  await Token.connect(insurerSigner).approve(pool.address, reserveAmt);
  await pool.connect(insurerSigner).seedReserve(reserveAmt);
  console.log("✅ InsurancePool seeded with reserve");

  // 6) Deploy ClaimEscrow
  const escrow = await new ethers.ContractFactory(
    C('ClaimEscrow','ClaimEscrow.sol').abi,
    C('ClaimEscrow','ClaimEscrow.sol').evm.bytecode.object,
    adminSigner
  ).deploy(
    Token.address,
    registry.address,
    apptMgr.address,
    insurance.address,
    pool.address          // Added
  );
  await escrow.deployed();
  console.log("✅ All core contracts deployed");

  // 7) Doctor registration & appointment
  await registry.connect(adminSigner).addDoctor(doctor);
  await apptMgr.connect(patientSigner).requestAppointment(doctor);
  await apptMgr.connect(doctorSigner).confirmAppointment(patient);
  console.log("✅ Doctor & appointment setup complete");

  // 8) Insurance policy tests
  let threw = false;
  try { await insurance.getPolicy(patient); } catch { threw = true; }
  if (!threw) throw new Error("getPolicy should revert without policy");
  console.log("✅ getPolicy reverts without policy");

  await insurance.connect(adminSigner).setPolicy(patient, insurer, 80);
  const [insAddr, pct] = await insurance.getPolicy(patient);
  if (insAddr !== insurer || !pct.eq(80)) throw new Error("setPolicy or getPolicy returned wrong data");
  console.log("✅ setPolicy & getPolicy work");

  await insurance.connect(adminSigner).revokePolicy(patient);
  threw = false;
  try { await insurance.getPolicy(patient); } catch { threw = true; }
  if (!threw) throw new Error("revokePolicy failed");
  console.log("✅ revokePolicy works");

  await insurance.connect(adminSigner).setPolicy(patient, insurer, 75);
  console.log("✅ Policy reset (75% coverage)");

  // 9) ClaimEscrow – successful flow & reputation reward
  const claimAmount = ethers.utils.parseEther("100");
  await Token.connect(patientSigner).approve(escrow.address, claimAmount.mul(50).div(100));
  await Token.connect(doctorSigner).approve(escrow.address,  claimAmount.mul(50).div(100));
  await Token.connect(insurerSigner).approve(escrow.address, claimAmount);
  await escrow.connect(patientSigner).initiateClaim(doctor, claimAmount, false);
  console.log("✅ initiateClaim");
  await escrow.releaseInitial(0);
  console.log("✅ releaseInitial");

  await provider.send("evm_increaseTime", [31 * 24 * 3600]);
  await provider.send("evm_mine");

  await escrow.completeClaim(0);
  console.log("✅ completeClaim returns remainder & returns stakes");

  const patPct1 = await escrow.getPatientPct(patient);
  const docPct1 = await escrow.getDoctorPct(doctor);
  if (!patPct1.eq(45) || !docPct1.eq(45)) {
    throw new Error(`Reputation not rewarded properly: got patient ${patPct1}, doctor ${docPct1}`);
  }
  console.log("✅ reputation rewarded: patient pct =", patPct1.toString(), ", doctor pct =", docPct1.toString());

  // 10) Dispute flow & penalty
  await provider.send("evm_increaseTime", [-31 * 24 * 3600]);
  await provider.send("evm_mine");
  await Token.connect(patientSigner).approve(escrow.address, claimAmount.mul(45).div(100));
  await Token.connect(doctorSigner).approve(escrow.address,  claimAmount.mul(45).div(100));
  await Token.connect(insurerSigner).approve(escrow.address, claimAmount);
  await escrow.connect(patientSigner).initiateClaim(doctor, claimAmount, false);
  console.log("✅ initiateClaim #2");
  await escrow.releaseInitial(1);
  console.log("✅ releaseInitial #2");

  await escrow.connect(insurerSigner).disputeClaim(1);
  console.log("✅ disputeClaim within period");

  const patPct2 = await escrow.getPatientPct(patient);
  const docPct2 = await escrow.getDoctorPct(doctor);
  if (!patPct2.eq(65) || !docPct2.eq(55)) {
    throw new Error(`Reputation not penalized properly: got patient ${patPct2}, doctor ${docPct2}`);
  }
  console.log("✅ reputation penalized: patient pct =", patPct2.toString(), ", doctor pct =", docPct2.toString());

  console.log("\n🎉 All tests passed!");
}

main().catch(err => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
