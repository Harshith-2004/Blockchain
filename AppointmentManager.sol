// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./DoctorRegistry.sol";

contract AppointmentManager {
    DoctorRegistry public registry;

    // patient ⇒ doctor ⇒ authorized?
    mapping(address => mapping(address => bool)) public isAuthorized;

    event AppointmentRequested(address indexed patient, address indexed doctor);
    event AppointmentConfirmed(address indexed doctor, address indexed patient);

    constructor(address _registry) {
        registry = DoctorRegistry(_registry);
    }

    /// Patient requests an OP visit with a specific doctor
    function requestAppointment(address _doctor) external {
        require(registry.isDoctor(_doctor), "Not a registered doctor");
        emit AppointmentRequested(msg.sender, _doctor);
    }

    /// Doctor confirms the appointment
    function confirmAppointment(address _patient) external {
        require(registry.isDoctor(msg.sender), "Not a registered doctor");
        isAuthorized[_patient][msg.sender] = true;
        emit AppointmentConfirmed(msg.sender, _patient);
    }

    /// Check helper
    function checkAuthorized(address _patient, address _doctor) external view returns (bool) {
        return isAuthorized[_patient][_doctor];
    }
}
