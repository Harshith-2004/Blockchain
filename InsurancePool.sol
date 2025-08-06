// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";

/// @title InsurancePool
/// @dev Holds insurer collateral & collects premiums
contract InsurancePool {
    IERC20 public immutable stablecoin;
    uint256 public reserve;           // total collateral
    uint256 public immutable minCover; // percent of cover required, e.g. 150 == 150%

    mapping(address => mapping(address => uint256)) public premiumPaid;
    // patient ⇒ insurer ⇒ amount

    event Seeded(address indexed insurer, uint256 amount);
    event PremiumPaid(address indexed patient, address indexed insurer, uint256 amount);
    event ReserveTopped(address indexed insurer, uint256 amount);

    constructor(address _stablecoin, uint256 _minCoverPct) {
        stablecoin = IERC20(_stablecoin);
        minCover    = _minCoverPct;
    }

    /// @dev Insurer seeds the reserve
    function seedReserve(uint256 amount) external {
        require(amount > 0, "amount>0");
        stablecoin.transferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit Seeded(msg.sender, amount);
    }

    /// @dev Patient pays a premium to insurer
    function payPremium(address insurer, uint256 amount) external {
        require(amount > 0, "amount>0");
        stablecoin.transferFrom(msg.sender, address(this), amount);
        premiumPaid[msg.sender][insurer] += amount;
        reserve += amount;
        emit PremiumPaid(msg.sender, insurer, amount);
    }

    /// @dev Allow insurer to top up reserve
    function topUpReserve(uint256 amount) external {
        require(amount > 0, "amount>0");
        stablecoin.transferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit ReserveTopped(msg.sender, amount);
    }

    /// @dev Check if there's enough collateral for a new claim of size `amt`
    function hasCapacity(uint256 amt) external view returns (bool) {
        // require reserve ≥ amt * minCover%
        return reserve * 100 >= amt * minCover;
    }

    /// @dev Release funds when a claim is finalized or disputed
    function release(uint256 amount) external {
        // only ClaimEscrow calls this
        reserve -= amount;
        stablecoin.transfer(msg.sender, amount);
    }
}
