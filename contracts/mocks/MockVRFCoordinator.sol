// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/**
 * @notice Minimal mock VRF Coordinator for testing LiquidLottery.
 *         Stores pending requests and lets the test script fulfill them
 *         with chosen random words.
 */
contract MockVRFCoordinator {
    uint256 private _nextRequestId = 1;
    mapping(uint256 => address) public requestConsumer;

    // Matches the IVRFCoordinatorV2Plus interface
    function requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest calldata
    ) external returns (uint256 requestId) {
        requestId = _nextRequestId++;
        requestConsumer[requestId] = msg.sender;
    }

    /**
     * @notice Test helper: deliver random words to the consumer.
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external {
        address consumer = requestConsumer[requestId];
        require(consumer != address(0), "no such request");

        (bool ok, ) = consumer.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                randomWords
            )
        );
        require(ok, "callback failed");
    }
}
