// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract PatientWallet {
    address public patient;
    address public recordManager;

    mapping(bytes32 => string) private records;   // stores record hashes -> metadata URI

    event RecordAdded(bytes32 indexed recordHash, string uri);
    event PaymentReceived(address indexed from, uint256 amount);
    event PaymentSent(address indexed to, uint256 amount);
    event RecordManagerSet(address indexed manager);

    constructor(address _patient) payable {
        require(_patient != address(0), "Invalid patient address");
        patient = _patient;
    }

    /// Only the patient may call
    modifier onlyPatient() {
        require(msg.sender == patient, "Only patient can call");
        _;
    }

    /// Only the designated recordManager contract may call
    modifier onlyManager() {
        require(msg.sender == recordManager, "Only record manager can call");
        _;
    }

    /// Patient assigns which contract may push records
    function setRecordManager(address _manager) external onlyPatient {
        require(_manager != address(0), "Invalid manager address");
        recordManager = _manager;
        emit RecordManagerSet(_manager);
    }

    /// Called by recordManager to store a medical record hash + URI
    function addRecord(bytes32 recordHash, string calldata uri) external onlyManager {
        records[recordHash] = uri;
        emit RecordAdded(recordHash, uri);
    }

    /// Public getter for any stored record URI
    function getRecordURI(bytes32 recordHash) external view returns (string memory) {
        return records[recordHash];
    }

    /// Allow this contract to receive Ether
    receive() external payable {
        emit PaymentReceived(msg.sender, msg.value);
    }

    /// Patient can send Ether from this wallet to another address
    function sendPayment(address payable to, uint256 amount) external onlyPatient {
        require(address(this).balance >= amount, "Insufficient balance");
        to.transfer(amount);
        emit PaymentSent(to, amount);
    }
}
