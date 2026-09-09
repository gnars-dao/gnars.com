// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Test-only token: installed at the DAO address exclusively inside an isolated localhost fork.
contract SweepERC721Fixture {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address owner, uint256 tokenId) external {
        require(ownerOf[tokenId] == address(0), "exists");
        ownerOf[tokenId] = owner;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd;
    }

    function approve(address operator, uint256 tokenId) external {
        require(msg.sender == ownerOf[tokenId], "not owner");
        getApproved[tokenId] = operator;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(from == ownerOf[tokenId] && to != address(0), "invalid transfer");
        require(msg.sender == from || msg.sender == getApproved[tokenId], "not approved");
        delete getApproved[tokenId];
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
