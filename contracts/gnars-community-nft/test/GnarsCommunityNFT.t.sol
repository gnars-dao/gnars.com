// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {GnarsCommunityNFT} from "../src/GnarsCommunityNFT.sol";

interface Vm {
    function chainId(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}
contract MembershipFixture {
    mapping(address => uint256) public balanceOf;
    function set(address account, uint256 value) external { balanceOf[account] = value; }
}
contract SmartCreatorFixture {
    function create(GnarsCommunityNFT nft, bytes32 id, string calldata uri) external returns(uint256) { return nft.mint(id, uri); }
}
contract GnarsCommunityNFTTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MembershipFixture membership;
    GnarsCommunityNFT nft;
    address creator = address(0x1234);
    address split = address(0x5678);
    string constant URI = "ipfs://bafybeib7irehgjoi27ikzc3p3isxo35vh6hcjjbuhz37wpikpj56p6dxvq";

    function setUp() public {
        vm.chainId(8453);
        membership = new MembershipFixture();
        nft = new GnarsCommunityNFT(address(membership), split, 150);
        membership.set(creator, 6);
    }
    function testEoaCreatesImmutableMetadataAndRoyalty() public {
        vm.prank(creator);
        uint256 id = nft.mint(bytes32(uint256(1)), URI);
        require(nft.ownerOf(id) == creator);
        require(nft.creators(id) == creator);
        require(keccak256(bytes(nft.tokenURI(id))) == keccak256(bytes(URI)));
        (address recipient, uint256 amount) = nft.royaltyInfo(id, 1 ether);
        require(recipient == split && amount == 0.015 ether);
        require(nft.supportsInterface(0x80ac58cd) && nft.supportsInterface(0x2a55205a));
    }
    function testFiveGnarsCannotMint() public {
        membership.set(creator, 5);
        vm.prank(creator); vm.expectRevert(GnarsCommunityNFT.MembershipRequired.selector);
        nft.mint(bytes32(uint256(1)), URI);
    }
    function testRetryCannotCreateSecondToken() public {
        vm.prank(creator); nft.mint(bytes32(uint256(1)), URI);
        vm.prank(creator); vm.expectRevert(GnarsCommunityNFT.DuplicateRequest.selector);
        nft.mint(bytes32(uint256(1)), URI);
        require(nft.totalMinted() == 1);
    }
    function testSmartWalletOwnsItsMint() public {
        SmartCreatorFixture smart = new SmartCreatorFixture();
        membership.set(address(smart), 6);
        uint256 id = smart.create(nft, bytes32(uint256(2)), URI);
        require(nft.ownerOf(id) == address(smart));
    }
    function testRejectsMutableMetadata() public {
        vm.prank(creator); vm.expectRevert(GnarsCommunityNFT.InvalidMetadata.selector);
        nft.mint(bytes32(uint256(1)), "https://example.org/mutable.json");
    }
    function testNoEthereumDeployment() public {
        vm.chainId(1); vm.expectRevert(GnarsCommunityNFT.InvalidConfiguration.selector);
        new GnarsCommunityNFT(address(membership), split, 150);
    }
    function testNoImplicitZeroRoyalty() public {
        vm.expectRevert(GnarsCommunityNFT.InvalidConfiguration.selector);
        new GnarsCommunityNFT(address(membership), split, 0);
    }
}
