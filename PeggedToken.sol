// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Minimal ERC-20
contract PeggedToken {
  string public name    = "MockUSD";
  string public symbol  = "mUSD";
  uint8  public decimals= 18;
  uint256 public totalSupply;
  mapping(address=>uint256) public balanceOf;
  mapping(address=>mapping(address=>uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  MockV3Aggregator public priceFeed;
  uint256 public constant FEED_DECIMALS = 1e8;

  constructor(address _feed) {
    priceFeed = MockV3Aggregator(_feed);
    _mint(msg.sender, 1_000_000 * 10**18);
  }

  function _mint(address to, uint256 amt) internal {
    totalSupply += amt;
    balanceOf[to] += amt;
    emit Transfer(address(0), to, amt);
  }
  function _burn(address from, uint256 amt) internal {
    balanceOf[from] -= amt;
    totalSupply   -= amt;
    emit Transfer(from, address(0), amt);
  }

  function transfer(address to, uint256 v) external returns(bool) {
    require(balanceOf[msg.sender]>=v,"bal");
    balanceOf[msg.sender]-=v;
    balanceOf[to]      +=v;
    emit Transfer(msg.sender,to,v);
    return true;
  }
  function approve(address sp, uint256 v) external returns(bool){
    allowance[msg.sender][sp]=v;
    emit Approval(msg.sender,sp,v);
    return true;
  }
  function transferFrom(address f,address t,uint256 v) external returns(bool){
    require(balanceOf[f]>=v,"bal");
    require(allowance[f][msg.sender]>=v,"allow");
    allowance[f][msg.sender]-=v;
    balanceOf[f]-=v;
    balanceOf[t]+=v;
    emit Transfer(f,t,v);
    return true;
  }

  /// @notice read the feed’s 8-decimal price
  function getPegPrice() public view returns(uint256) {
    (,int256 ans,,,) = priceFeed.latestRoundData();
    require(ans>0,"bad");
    return uint256(ans);
  }

  /// @notice toy mint/burn to nudge price toward peg=1e8
  function adjustSupply() external {
    uint256 p = getPegPrice();
    if (p > FEED_DECIMALS) {
      _mint(msg.sender, 1 * 10**decimals);
    } else if (p < FEED_DECIMALS) {
      _burn(msg.sender, 1 * 10**decimals);
    }
  }
}

interface MockV3Aggregator {
  function latestRoundData() external view returns (
    uint80, int256, uint256, uint256, uint80
  );
}
