// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILottery {
    function claimNFTRevenue(uint256 tokenId) external;
    function claimReferralEarnings() external;
    function claimPendingPayout() external;
    function pendingPayouts(address) external view returns (uint256);
}

contract RejectETH {
    receive() external payable { revert("no ETH"); }

    /// @dev Accept ERC721 safe transfers so the contract can hold NFTs.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function callClaimNFTRevenue(address lottery, uint256 tokenId) external {
        ILottery(lottery).claimNFTRevenue(tokenId);
    }

    function callClaimReferralEarnings(address lottery) external {
        ILottery(lottery).claimReferralEarnings();
    }

    function callClaimPendingPayout(address lottery) external {
        ILottery(lottery).claimPendingPayout();
    }
}
