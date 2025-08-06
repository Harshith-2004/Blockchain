// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract DoctorRegistry {
    address public admin;
    mapping(address => bool) public isDoctor;

    event DoctorAdded(address indexed doctor);
    event DoctorRemoved(address indexed doctor);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function addDoctor(address _doctor) external onlyAdmin {
        isDoctor[_doctor] = true;
        emit DoctorAdded(_doctor);
    }

    function removeDoctor(address _doctor) external onlyAdmin {
        isDoctor[_doctor] = false;
        emit DoctorRemoved(_doctor);
    }
}
