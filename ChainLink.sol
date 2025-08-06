// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract MyStablecoin {
    AggregatorV3Interface public priceFeed;
    mapping(address=>uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address _priceFeed) {
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /// @dev Returns price of 1 ETH in USD, scaled by 1e8 (Chainlink standard)
    function getLatestETHUSD() public view returns (uint256) {
        (,int256 price,,,) = priceFeed.latestRoundData();
        require(price > 0, "Invalid price");
        return uint256(price);
    }

    /// @dev Example: mint stablecoins against ETH collateral
    function mintWithETH() external payable {
        uint256 ethAmount = msg.value;               // in wei
        uint256 ethPrice  = getLatestETHUSD();       // e.g. 3,000.00 USD * 1e8
        // Suppose we allow 150% collateralization:
        // max USD-value we can mint = ethAmount * ethPrice / 1e8 * (100 / 150)
        uint256 usdValue  = (ethAmount * ethPrice) / 1e8;
        uint256 mintAmt   = (usdValue * 100) / 150;   // user gets 2/3 of USD value
        totalSupply += mintAmt;
        balanceOf[msg.sender] += mintAmt;
        // ETH stays in contract as collateral...
    }

    /// @dev Burn stablecoins to withdraw ETH, at current price
    function redeemETH(uint256 stableAmt) external {
        require(balanceOf[msg.sender] >= stableAmt, "Not enough tokens");
        uint256 ethPrice = getLatestETHUSD();
        uint256 usdValue = stableAmt;                // 1 token = $1
        // ETH to return = usdValue / (ethPrice / 1e8)
        uint256 ethToReturn = (usdValue * 1e8) / ethPrice;
        balanceOf[msg.sender] -= stableAmt;
        totalSupply     -= stableAmt;
        payable(msg.sender).transfer(ethToReturn);
    }
}
