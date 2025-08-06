/* test1.js */
// Ensure you have ethers@5 installed: npm install ethers@5 solc

const { ethers } = require("ethers");
const fs = require('fs');
const solc = require('solc');

async function main() {
  // Connect to local Ganache CLI (ethers v5)
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const accounts = await provider.listAccounts();
  const deployer = provider.getSigner(accounts[0]);
  const patientSigner = provider.getSigner(accounts[1]);
  const doctor = accounts[2];

  // Compile & deploy PatientWallet
  const source = fs.readFileSync('./PatientWallet.sol', 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'PatientWallet.sol': { content: source } },
    settings: { outputSelection: { '*': { '*': ['abi','evm.bytecode'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const abi = output.contracts['PatientWallet.sol']['PatientWallet'].abi;
  const bytecode = output.contracts['PatientWallet.sol']['PatientWallet'].evm.bytecode.object;

  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  console.log('Deploying PatientWallet...');
  const wallet = await factory.deploy(
    accounts[1],               // patient address
    { value: ethers.utils.parseEther('1'), gasLimit: 6000000 }
  );
  await wallet.deployed();
  console.log('PatientWallet deployed at:', wallet.address);

  // Check initial balance
  let balance = await provider.getBalance(wallet.address);
  console.log('Initial wallet balance:', ethers.utils.formatEther(balance));

  // ─── NEW: set the recordManager so patientSigner can call addRecord ───────
  await wallet
    .connect(patientSigner)
    .setRecordManager(accounts[1]);
  console.log("✅ recordManager set to patient");

  // Patient adds a record
  console.log('Adding medical record...');
  const recordKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('record1'));
  const recordURI = 'ipfs://Qm...';
  await wallet
    .connect(patientSigner)
    .addRecord(recordKey, recordURI, { gasLimit: 200000 });
  console.log('Record added by patient:', recordKey, recordURI);

  // Retrieve the stored record URI
  console.log('Retrieving medical record...');
  const storedURI = await wallet
    .connect(patientSigner)
    .getRecordURI(recordKey);
  console.log('Retrieved URI for', recordKey, ':', storedURI);

  // Patient sends payment to doctor
  console.log('Sending payment to doctor...');
  const tx = await wallet
    .connect(patientSigner)
    .sendPayment(doctor, ethers.utils.parseEther('0.1'), { gasLimit: 200000 });
  await tx.wait();
  console.log('Payment of 0.1 ETH sent to doctor:', doctor);

  // Check final balance
  balance = await provider.getBalance(wallet.address);
  console.log('Final wallet balance:', ethers.utils.formatEther(balance));
}

main().catch(error => {
  console.error('Error in script:', error);
  process.exit(1);
});
