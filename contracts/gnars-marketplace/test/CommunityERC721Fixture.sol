// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only token for local fork settlement. Never deploy this fixture to a live network.
contract CommunityERC721Fixture {
    address public owner;
    address public immutable royaltyReceiver;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    constructor(address initialOwner, address royalty) {
        owner = initialOwner;
        royaltyReceiver = royalty;
        emit Transfer(address(0), initialOwner, 1);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x2a55205a;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        require(tokenId == 1, "missing token");
        return owner;
    }

    function balanceOf(address account) external view returns (uint256) {
        return account == owner ? 1 : 0;
    }

    function approve(address operator, uint256 tokenId) external {
        require(msg.sender == owner && tokenId == 1, "not owner");
        getApproved[tokenId] = operator;
        emit Approval(owner, operator, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(tokenId == 1 && from == owner && to != address(0), "invalid transfer");
        require(msg.sender == owner || msg.sender == getApproved[tokenId], "not approved");
        delete getApproved[tokenId];
        owner = to;
        emit Transfer(from, to, tokenId);
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (royaltyReceiver, salePrice * 500 / 10000);
    }
}
