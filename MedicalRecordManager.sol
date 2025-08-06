// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./DoctorRegistry.sol";
import "./AppointmentManager.sol";
import "./PatientWallet.sol";

contract MedicalRecordManager {
    DoctorRegistry     public registry;
    AppointmentManager public appts;

    struct Entry {
        address doctor;
        address patient;
        bytes32 recordHash;
        string  uri;
        bool    approvedByPatient;
    }

    Entry[] public entries;
    event RecordProposed(uint256 indexed id, address indexed doctor, address indexed patient);
    event RecordApproved(uint256 indexed id);
    event RecordFinalized(uint256 indexed id);

    constructor(address _registry, address _apptMgr) {
        registry = DoctorRegistry(_registry);
        appts    = AppointmentManager(_apptMgr);
    }

    function proposeRecord(address _patient, bytes32 _hash, string calldata _uri) external {
        require(registry.isDoctor(msg.sender),            "Not a registered doctor");
        require(appts.isAuthorized(_patient, msg.sender), "Doctor not authorized for OP visit");
        uint256 id = entries.length;
        entries.push(Entry(msg.sender, _patient, _hash, _uri, false));
        emit RecordProposed(id, msg.sender, _patient);
    }

    function approveRecord(uint256 id) external {
        Entry storage e = entries[id];
        require(msg.sender == e.patient,        "Only patient");
        require(!e.approvedByPatient,           "Already approved");
        e.approvedByPatient = true;
        emit RecordApproved(id);
    }

    // ← Here’s the only change: address payable
    function finalizeRecord(address payable walletAddr, uint256 id) external {
        Entry storage e = entries[id];
        require(e.approvedByPatient, "Patient hasn't approved");
        PatientWallet(walletAddr).addRecord(e.recordHash, e.uri);
        emit RecordFinalized(id);
    }
}
