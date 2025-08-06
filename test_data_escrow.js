// test_data_escrow.js
// Dependencies: ethers@5, solc
// Usage: node test_data_escrow.js

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // 1) Compile
  const files = [
    "TestToken.sol",
    "DoctorRegistry.sol",
    "AppointmentManager.sol",
    "PatientWallet.sol",
    "ResearchRegistry.sol",
    "DataEscrow.sol"
  ];
  const src = {};
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`${f} not found`);
    src[f] = fs.readFileSync(f, "utf8");
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(src).map(([fn, c])=>[fn,{content:c}])),
    settings:{outputSelection:{"*":{"*":["abi","evm.bytecode"]}}}
  };
  function find(path){ const k=path.replace("./",""); return src[k]?{contents:src[k]}:{error:"File not found"};}
  const out = JSON.parse(solc.compile(JSON.stringify(input),{import:find}));
  if (out.errors) for (const e of out.errors) if(e.severity==="error") throw new Error(e.formattedMessage);
  const C = (n,f)=>out.contracts[f][n];

  // 2) Setup
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accts    = await provider.listAccounts();
  const [admin, patient, doctor, researcher, arbitrator] = accts;
  const adminS   = provider.getSigner(admin);
  const patS     = provider.getSigner(patient);
  const docS     = provider.getSigner(doctor);
  const resS     = provider.getSigner(researcher);
  const arbS     = provider.getSigner(arbitrator);

  // 3) Token & fund
  const T = await new ethers.ContractFactory(C("TestToken","TestToken.sol").abi,C("TestToken","TestToken.sol").evm.bytecode.object,adminS).deploy();
  await T.deployed();
  const initial = ethers.utils.parseEther("1000");
  for (const a of [patient, doctor, researcher]) await T.connect(adminS).transfer(a, initial);

  // 4) Registries, wallet, DataEscrow
  const docReg = await new ethers.ContractFactory(C("DoctorRegistry","DoctorRegistry.sol").abi,C("DoctorRegistry","DoctorRegistry.sol").evm.bytecode.object,adminS).deploy();
  const appt   = await new ethers.ContractFactory(C("AppointmentManager","AppointmentManager.sol").abi,C("AppointmentManager","AppointmentManager.sol").evm.bytecode.object,adminS).deploy(docReg.address);
  const pw     = await new ethers.ContractFactory(C("PatientWallet","PatientWallet.sol").abi,C("PatientWallet","PatientWallet.sol").evm.bytecode.object,adminS)
                    .deploy(patient,{value:ethers.utils.parseEther("1")});
  await pw.deployed();
  const resReg = await new ethers.ContractFactory(C("ResearchRegistry","ResearchRegistry.sol").abi,C("ResearchRegistry","ResearchRegistry.sol").evm.bytecode.object,adminS).deploy();
  const dataEsc= await new ethers.ContractFactory(C("DataEscrow","DataEscrow.sol").abi,C("DataEscrow","DataEscrow.sol").evm.bytecode.object,adminS)
                    .deploy(T.address, resReg.address, appt.address, pw.address, arbitrator);
  await dataEsc.deployed();
  await pw.connect(patS).setRecordManager(dataEsc.address);

  console.log("✅ Core contracts deployed");
    // ─── Register both doctor & researcher in DoctorRegistry ────────────────
  await docReg.connect(adminS).addDoctor(doctor);
  await docReg.connect(adminS).addDoctor(researcher);
  console.log("✅ Registered doctor & researcher in DoctorRegistry");


  // 5) Register & consent
  await docReg.connect(adminS).addDoctor(doctor);
  await appt.connect(patS).requestAppointment(doctor);
  await appt.connect(docS).confirmAppointment(patient);

  await appt.connect(patS).requestAppointment(researcher);
  await appt.connect(resS).confirmAppointment(patient);

  await resReg.connect(adminS).addResearcher(researcher);
  console.log("✅ Registrations & OP consent done");

  // 6) Happy‐path
  const amt = ethers.utils.parseEther("10");
  await T.connect(resS).approve(dataEsc.address, amt);
  await T.connect(patS).approve(dataEsc.address, amt);

  await dataEsc.connect(resS).initiateRequest(patient, amt, ethers.utils.id("h1"));
  console.log("✅ initiateRequest");

  await dataEsc.connect(patS).fulfillData(0, ethers.utils.id("h1"), "ipfs://Qm...");
  console.log("✅ fulfillData");

  await provider.send("evm_increaseTime",[8*24*3600]); await provider.send("evm_mine");
  await dataEsc.autoComplete(0);
  console.log("✅ completeRequest");

  const balPat1 = await T.balanceOf(patient);
  if (!balPat1.eq(initial.add(amt))) throw new Error("patient payout wrong");
  console.log("✅ patient got deposit + stake back");

  // 7) Dispute‐path
  // new request id=1
  await T.connect(resS).approve(dataEsc.address, amt);
  await T.connect(patS).approve(dataEsc.address, amt);
  await dataEsc.connect(resS).initiateRequest(patient, amt, ethers.utils.id("h2"));
  await dataEsc.connect(patS).fulfillData(1, ethers.utils.id("h2"), "ipfs://Qm2");
  console.log("✅ second flow");

  // researcher flags
  await dataEsc.connect(resS).flagDispute(1);
  console.log("✅ dispute flagged");

  // record balances
  const beforeRes = await T.balanceOf(researcher);
  const beforePat = await T.balanceOf(patient);

  // arbitrator resolves in favor of researcher (true)
  await dataEsc.connect(arbS).resolveDispute(1, true);
  console.log("✅ dispute resolved by arbitrator");

  // researcher should get deposit+stake
  const gotRes = (await T.balanceOf(researcher)).sub(beforeRes);
  if (!gotRes.eq(amt.add(amt))) {
    throw new Error(`researcher got ${gotRes}, expected ${amt.add(amt)}`);
  }
  // patient gets nothing
  if (! (await T.balanceOf(patient)).eq(beforePat) ) {
    throw new Error("patient should not get funds on dispute-loss");
  }

  // reputational penalty
  const pct = await dataEsc.getPatientPct(patient);
  if (!pct.eq(110)) throw new Error("patient pct not penalized");

  console.log("\n🎉 All DataEscrow arbitration tests pass!");
}

main().catch(e=>{
  console.error("❌ Test failure:",e);
  process.exit(1);
});
