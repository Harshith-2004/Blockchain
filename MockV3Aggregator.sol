// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockV3Aggregator {
  int256 public answer;

  constructor(int256 _initialAnswer) {
    answer = _initialAnswer;
  }

  /// @notice Chainlink compatibility
  function latestRoundData()
    external
    view
    returns (
      uint80 roundId,
      int256 answer_,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    )
  {
    return (0, answer, 0, block.timestamp, 0);
  }

  /// @notice Let tests simulate a price change
  function updateAnswer(int256 _newAnswer) external {
    answer = _newAnswer;
  }
}
