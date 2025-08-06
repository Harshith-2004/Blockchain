// test.js
// Run with: node test.js
// Dependencies: ethers@5, solc
const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // ─── Step 1: Load & compile all contracts ─────────────────────────────────────
  const files = [
    "PatientWallet.sol",
    "DoctorRegistry.sol",
    "AppointmentManager.sol",
    "MedicalRecordManager.sol"
  ];
  const sources = {};
  for (let f of files) {
    if (!fs.existsSync(f)) throw new Error(`${f} not found`);
    sources[f] = fs.readFileSync(f, "utf8");
  }

  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      Object.entries(sources).map(([filename, content]) => [filename, { content }])
    ),
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } }
  };

  function findImports(path) {
    const key = path.startsWith("./") ? path.slice(2) : path;
    if (sources[key]) return { contents: sources[key] };
    return { error: "File not found: " + path };
  }

  console.log("Compiling contracts...");
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    for (let e of output.errors) {
      // fail on errors (but allow warnings)
      if (e.severity === "error") {
        console.error(e.formattedMessage);
        process.exit(1);
      }
      console.warn(e.formattedMessage);
    }
  }

  const contracts = {};
  for (let file of files) {
    const name = file.replace(".sol", "");
    const json = output.contracts[file]?.[name];
    if (!json) throw new Error(`Missing ${name} in compilation output`);
    contracts[name] = { abi: json.abi, bytecode: json.evm.bytecode.object };
  }

  // ─── Step 2: Setup provider & signers ──────────────────────────────────────────
  const provider      = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accounts      = await provider.listAccounts();
  const adminSigner   = provider.getSigner(accounts[0]);
  const patientSigner = provider.getSigner(accounts[1]);
  const doctorSigner  = provider.getSigner(accounts[2]);
  const badDoctor     = provider.getSigner(accounts[3]);

  // ─── Step 3: Deploy DoctorRegistry ─────────────────────────────────────────────
  console.log("Deploying DoctorRegistry...");
  const Registry = await new ethers.ContractFactory(
    contracts.DoctorRegistry.abi,
    contracts.DoctorRegistry.bytecode,
    adminSigner
  ).deploy();
  await Registry.deployed();
  console.log(" →", Registry.address);

  // ─── Step 4: Deploy AppointmentManager ────────────────────────────────────────
  console.log("Deploying AppointmentManager...");
  const ApptMgr = await new ethers.ContractFactory(
    contracts.AppointmentManager.abi,
    contracts.AppointmentManager.bytecode,
    adminSigner
  ).deploy(Registry.address);
  await ApptMgr.deployed();
  console.log(" →", ApptMgr.address);

  // ─── Step 5: Deploy MedicalRecordManager ─────────────────────────────────────
  console.log("Deploying MedicalRecordManager...");
  const MRM = await new ethers.ContractFactory(
    contracts.MedicalRecordManager.abi,
    contracts.MedicalRecordManager.bytecode,
    adminSigner
  ).deploy(Registry.address, ApptMgr.address);
  await MRM.deployed();
  console.log(" →", MRM.address);

  // ─── Step 6: Deploy & fund PatientWallet ──────────────────────────────────────
  console.log("Deploying PatientWallet with 1 ETH...");
  const Wallet = await new ethers.ContractFactory(
    contracts.PatientWallet.abi,
    contracts.PatientWallet.bytecode,
    adminSigner
  ).deploy(accounts[1], { value: ethers.utils.parseEther("1") , gasLimit: 6_000_000 });
  await Wallet.deployed();
  console.log(" →", Wallet.address);

  // Verify initial balance = 1 ETH
  let bal = await provider.getBalance(Wallet.address);
  if (bal.toString() !== ethers.utils.parseEther("1").toString()) {
    throw new Error("Initial balance not 1 ETH");
  }
  console.log(" ✅ PatientWallet funded with 1 ETH");

  // ─── Step 7: Wire up recordManager ───────────────────────────────────────────
  await Wallet.connect(patientSigner).setRecordManager(MRM.address);
  console.log(" ✅ recordManager set to MedicalRecordManager");

  // ─── Step 8: DoctorRegistry tests ────────────────────────────────────────────
  // Initially, doctorSigner is NOT registered
  if (await Registry.isDoctor(accounts[2])) {
    throw new Error("doctorSigner should not be registered yet");
  }
  // Admin registers them
  await Registry.connect(adminSigner).addDoctor(accounts[2]);
  if (!await Registry.isDoctor(accounts[2])) {
    throw new Error("doctorSigner registration failed");
  }
  console.log(" ✅ DoctorRegistry.addDoctor / isDoctor");

  // ─── Step 9: Appointment flow tests ──────────────────────────────────────────
  // Patient requests appointment with doctorSigner
  await ApptMgr.connect(patientSigner).requestAppointment(accounts[2]);
  // doctorSigner confirms
  await ApptMgr.connect(doctorSigner).confirmAppointment(accounts[1]);
  if (!await ApptMgr.isAuthorized(accounts[1], accounts[2])) {
    throw new Error("Appointment authorization failed");
  }
  console.log(" ✅ AppointmentManager request/confirm/isAuthorized");

  // Unauthorized doctor should be blocked
  let threw = false;
  try {
    await ApptMgr.connect(badDoctor).confirmAppointment(accounts[1]);
  } catch (e) { threw = true; }
  if (!threw) throw new Error("Bad doctor should not confirm appointment");
  console.log(" ✅ Unauthorized doctor blocked from confirmAppointment");

  // ─── Step 10: MedicalRecordManager flow ────────────────────────────────────────
  const recordHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("rec1"));
  const recordURI  = "ipfs://Qm123";

  // Doctor proposes
  await MRM.connect(doctorSigner).proposeRecord(accounts[1], recordHash, recordURI);
  console.log(" ✅ proposeRecord");

  // Patient approves
  await MRM.connect(patientSigner).approveRecord(0);
  console.log(" ✅ approveRecord");

  // Finalize → pushes into PatientWallet
  await MRM.connect(adminSigner).finalizeRecord(Wallet.address, 0);
  console.log(" ✅ finalizeRecord");

  // Verify PatientWallet has stored the URI
  const stored = await Wallet.getRecordURI(recordHash);
  if (stored !== recordURI) {
    throw new Error("Stored URI mismatch");
  }
  console.log(" ✅ PatientWallet.getRecordURI");

  // Negative: unregistered doctor can't propose
  threw = false;
  try {
    await MRM.connect(badDoctor).proposeRecord(accounts[1], recordHash, recordURI);
  } catch(e) { threw = true; }
  if (!threw) throw new Error("Unregistered doctor must be blocked");
  console.log(" ✅ Unauthorized proposeRecord blocked");

  // Negative: unapproved record can't finalize
  // Propose a new one, but skip approval:
  await MRM.connect(doctorSigner).proposeRecord(accounts[1], recordHash, recordURI);
  threw = false;
  try {
    await MRM.connect(adminSigner).finalizeRecord(Wallet.address, 1);
  } catch(e) { threw = true; }
  if (!threw) throw new Error("Should not finalize without patient approval");
  console.log(" ✅ finalizeRecord blocked when not approved");

  // ─── Step 11: PatientWallet payment flow ──────────────────────────────────────
  const doctorAddr = accounts[2];
  // Patient sends 0.2 ETH
  await Wallet.connect(patientSigner).sendPayment(doctorAddr, ethers.utils.parseEther("0.2"));
  bal = await provider.getBalance(Wallet.address);
  if (bal.gte(ethers.utils.parseEther("0.8"))) {
    // it should now be 0.8 ETH
    console.log(" ✅ sendPayment worked; new balance:", ethers.utils.formatEther(bal));
  } else {
    throw new Error("sendPayment did not deduct correctly");
  }

  // Negative: only patient can send
  threw = false;
  try {
    await Wallet.connect(doctorSigner).sendPayment(accounts[3], 1);
  } catch (e) { threw = true; }
  if (!threw) throw new Error("Non-patient should not sendPayment");
  console.log(" ✅ sendPayment blocked for non-patient");

  // ─── All done! ─────────────────────────────────────────────────────────────────
  console.log("\n🎉 All tests passed!");
}

main().catch(err => {
  console.error("💥 Test failed:", err);
  process.exit(1);
});
