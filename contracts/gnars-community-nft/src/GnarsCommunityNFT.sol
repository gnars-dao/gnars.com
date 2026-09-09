// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721, ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Shared, non-upgradeable community collection. Metadata and royalties cannot be edited.
contract GnarsCommunityNFT is ERC721URIStorage, ERC2981, ReentrancyGuard {
    IERC721 public immutable gnars;
    address public immutable royaltyRecipient;
    uint96 public immutable royaltyBps;
    uint256 public constant MIN_GNARS = 6;
    uint256 public totalMinted;
    mapping(address creator => mapping(bytes32 requestId => uint256 tokenId)) public mintedRequests;
    mapping(uint256 tokenId => address creator) public creators;

    error InvalidConfiguration();
    error MembershipRequired();
    error InvalidMetadata();
    error DuplicateRequest();

    event Created(address indexed creator, uint256 indexed tokenId, bytes32 indexed requestId, string uri);

    constructor(address gnarsToken, address recipient, uint96 basisPoints)
        ERC721("Gnars Community", "GNARSC")
    {
        if (block.chainid != 8453 || gnarsToken.code.length == 0 || recipient == address(0) || basisPoints == 0 || basisPoints > 10000) {
            revert InvalidConfiguration();
        }
        gnars = IERC721(gnarsToken);
        royaltyRecipient = recipient;
        royaltyBps = basisPoints;
        _setDefaultRoyalty(recipient, basisPoints);
    }

    function mint(bytes32 requestId, string calldata uri) external nonReentrant returns (uint256 tokenId) {
        if (gnars.balanceOf(msg.sender) < MIN_GNARS) revert MembershipRequired();
        bytes memory value = bytes(uri);
        if (requestId == bytes32(0) || value.length < 8 || value.length > 256 || bytes7(value) != bytes7("ipfs://")) {
            revert InvalidMetadata();
        }
        if (mintedRequests[msg.sender][requestId] != 0) revert DuplicateRequest();
        tokenId = ++totalMinted;
        mintedRequests[msg.sender][requestId] = tokenId;
        creators[tokenId] = msg.sender;
        _mint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        // No receiver callback is needed: the caller deliberately mints to its own account.
        emit Created(msg.sender, tokenId, requestId, uri);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
