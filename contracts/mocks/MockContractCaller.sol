// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILiquidLotteryBuyTickets {
    function buyTickets(
        uint8[5][] calldata whites,
        uint8[]    calldata goldNums,
        uint8[]    calldata goldPositions,
        address    referrer
    ) external payable;
}

/**
 * @dev Helper used in tests to verify that the noContract modifier
 *      correctly blocks contract callers from buying tickets (MEDIUM-1).
 */
contract MockContractCaller {
    function tryBuyTickets(address lottery) external payable {
        uint8[5][] memory whites = new uint8[5][](1);
        whites[0] = [1, 2, 3, 4, 5];
        uint8[] memory goldNums = new uint8[](1);
        goldNums[0] = 10;
        uint8[] memory goldPositions = new uint8[](1);
        goldPositions[0] = 0;
        ILiquidLotteryBuyTickets(lottery).buyTickets{value: msg.value}(
            whites,
            goldNums,
            goldPositions,
            address(0)
        );
    }
}
