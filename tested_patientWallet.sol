// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract PatientWallet {
    address public patient;
    mapping(bytes32 => string) private records;   // stores record hashes -> metadata URI

    event RecordAdded(bytes32 indexed recordHash, string uri);
    event PaymentReceived(address indexed from, uint256 amount);
    event PaymentSent(address indexed to, uint256 amount);

    constructor(address _patient) payable {
        require(_patient != address(0), "Invalid patient address");
        patient = _patient;
    }

    // Only patient can add medical records
    modifier onlyPatient() {
        require(msg.sender == patient, "Only patient can call");
        _;
    }

    // Store a medical record hash on-chain with a pointer to off-chain data
    function addRecord(bytes32 recordHash, string calldata uri) external onlyPatient {
        records[recordHash] = uri;
        emit RecordAdded(recordHash, uri);
    }

    function getRecordURI(bytes32 recordHash) external view returns (string memory) {
        return records[recordHash];
    }

    // Allow this contract to receive Ether
    receive() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    // Pay from this wallet to a provider or insurer
    function sendPayment(address payable to, uint256 amount) external onlyPatient {
        require(address(this).balance >= amount, "Insufficient balance");
        to.transfer(amount);
        emit PaymentSent(to, amount);
    }
}
