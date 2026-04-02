// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title LiquidLotteryProxy
 * @notice Named ERC-1967 proxy for LiquidLotteryV1.
 *         Deploying as a named contract (rather than bare ERC1967Proxy) lets
 *         Hardhat identify calls in its verbose log as "LiquidLotteryProxy#"
 *         instead of "ERC1967Proxy#".
 */
contract LiquidLotteryProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
