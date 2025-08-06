// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ResearchRegistry {
    address public admin;
    mapping(address => bool) public isResearcher;

    event ResearcherAdded(address indexed researcher);
    event ResearcherRemoved(address indexed researcher);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function addResearcher(address _r) external onlyAdmin {
        require(_r != address(0), "Invalid address");
        isResearcher[_r] = true;
        emit ResearcherAdded(_r);
    }

    function removeResearcher(address _r) external onlyAdmin {
        isResearcher[_r] = false;
        emit ResearcherRemoved(_r);
    }
}
