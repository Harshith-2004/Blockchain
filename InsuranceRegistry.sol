// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InsuranceRegistry {
    address public admin;

    struct Policy {
        address insurer;
        uint256 coveragePercent; // e.g. 80 = covers 80% of the bill
        bool    exists;
    }

    // patient → their policy
    mapping(address => Policy) public policies;

    event PolicySet(address indexed patient, address indexed insurer, uint256 coveragePercent);
    event PolicyRevoked(address indexed patient);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    /// Admin sets a patient’s OP policy
    function setPolicy(address patient, address insurer, uint256 coveragePercent) external onlyAdmin {
        require(patient != address(0) && insurer != address(0), "Invalid address");
        require(coveragePercent <= 100, "Percent > 100");
        policies[patient] = Policy(insurer, coveragePercent, true);
        emit PolicySet(patient, insurer, coveragePercent);
    }

    /// Admin can revoke
    function revokePolicy(address patient) external onlyAdmin {
        require(policies[patient].exists, "No policy");
        delete policies[patient];
        emit PolicyRevoked(patient);
    }

    /// View helper
    function getPolicy(address patient) external view returns (address insurer, uint256 coveragePercent) {
        Policy storage p = policies[patient];
        require(p.exists, "No policy");
        return (p.insurer, p.coveragePercent);
    }
}
