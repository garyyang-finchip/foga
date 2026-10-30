// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Identity8004Stub} from "../src/Identity8004Stub.sol";

/// Minimal cheatcode surface so the test needs no external library.
interface Vm {
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
}

contract ReceiverOk {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract WalletStub1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 digest, bytes memory sig) external view returns (bytes4) {
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return ecrecover(digest, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0);
    }

    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "len");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}

contract Identity8004StubTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);

    Identity8004Stub reg;
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant WALLET_PK = 0xB0B;
    address alice;
    address wallet;

    function setUp() public {
        reg = new Identity8004Stub();
        alice = vm.addr(ALICE_PK);
        wallet = vm.addr(WALLET_PK);
    }

    function testRegisterAssignsSequentialIdsAndOwner() public {
        vm.prank(alice);
        uint256 a = reg.register("ipfs://agent-a");
        vm.prank(alice);
        uint256 b = reg.register();
        require(a == 1 && b == 2, "ids");
        require(reg.ownerOf(a) == alice && reg.balanceOf(alice) == 2, "owner");
        require(keccak256(bytes(reg.tokenURI(a))) == keccak256("ipfs://agent-a"), "uri");
        require(reg.getAgentWallet(a) == address(0), "wallet unset");
        require(reg.totalAgents() == 2, "count");
    }

    function testSetAgentWalletRequiresWalletSignature() public {
        vm.prank(alice);
        uint256 id = reg.register("x");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = reg.agentWalletDigest(id, wallet, alice, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit MetadataSet(id, "agentWallet", "agentWallet", abi.encode(wallet));
        reg.setAgentWallet(id, wallet, deadline, sig);
        require(reg.getAgentWallet(id) == wallet, "wallet set");
        require(keccak256(reg.getMetadata(id, "agentWallet")) == keccak256(abi.encode(wallet)), "metadata view");

        // a signature by someone else is rejected
        (v, r, s) = vm.sign(ALICE_PK, digest);
        vm.prank(alice);
        vm.expectRevert(bytes("Identity8004Stub: bad wallet signature"));
        reg.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }

    function testContractWalletViaErc1271() public {
        WalletStub1271 w = new WalletStub1271(wallet);
        vm.prank(alice);
        uint256 id = reg.register("x");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = reg.agentWalletDigest(id, address(w), alice, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);
        vm.prank(alice);
        reg.setAgentWallet(id, address(w), deadline, abi.encodePacked(r, s, v));
        require(reg.getAgentWallet(id) == address(w), "1271 wallet");
    }

    function testTransferClearsWalletAndEmitsMetadataSet() public {
        vm.prank(alice);
        uint256 id = reg.register("x");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = reg.agentWalletDigest(id, wallet, alice, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);
        vm.prank(alice);
        reg.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));

        address bob = address(0xB0B);
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit MetadataSet(id, "agentWallet", "agentWallet", abi.encode(address(0)));
        reg.transferFrom(alice, bob, id);
        require(reg.ownerOf(id) == bob, "new owner");
        require(reg.getAgentWallet(id) == address(0), "wallet cleared");
        require(reg.balanceOf(alice) == 0 && reg.balanceOf(bob) == 1, "balances");
    }

    function testSafeTransferToContractNeedsReceiver() public {
        vm.prank(alice);
        uint256 id = reg.register("x");
        ReceiverOk ok = new ReceiverOk();
        vm.prank(alice);
        reg.safeTransferFrom(alice, address(ok), id);
        require(reg.ownerOf(id) == address(ok), "receiver owns");

        vm.prank(address(ok));
        reg.transferFrom(address(ok), alice, id);
        vm.prank(alice);
        vm.expectRevert();
        reg.safeTransferFrom(alice, address(reg), id); // a contract without onERC721Received
    }

    function testMetadataAndReservedKey() public {
        vm.prank(alice);
        uint256 id = reg.register("x");
        vm.prank(alice);
        reg.setMetadata(id, "kya", hex"1234");
        require(keccak256(reg.getMetadata(id, "kya")) == keccak256(hex"1234"), "metadata");
        vm.prank(alice);
        vm.expectRevert(bytes("Identity8004Stub: use setAgentWallet"));
        reg.setMetadata(id, "agentWallet", hex"00");
        vm.prank(address(0xDEAD));
        vm.expectRevert(bytes("Identity8004Stub: not authorised"));
        reg.setMetadata(id, "kya", hex"00");
    }

    function testExpiredDeadlineRejected() public {
        vm.prank(alice);
        uint256 id = reg.register("x");
        uint256 deadline = block.timestamp + 10;
        bytes32 digest = reg.agentWalletDigest(id, wallet, alice, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WALLET_PK, digest);
        vm.warp(block.timestamp + 11);
        vm.prank(alice);
        vm.expectRevert(bytes("Identity8004Stub: expired"));
        reg.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }
}
