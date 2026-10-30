// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title  Identity8004Stub — a LOCAL-CHAIN stand-in for the ERC-8004 Identity Registry
/// @notice Deployed only into local worlds (Anvil / forks) so the ten-ERC stack can be exercised
///         without the official registry. It follows the official ABI surface that the ten reference
///         implementations call (register / ownerOf / getAgentWallet / setAgentWallet / getMetadata /
///         setMetadata / ERC-721 transfers) but it is NOT the reference implementation and must never
///         stand in for a public-chain deployment. Public worlds point at the official registry
///         (Sepolia 0x8004A818BFB912233c491871b3d84c89A494BD9e; mainnets 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432).
///
///         Deliberate choices, all documented in docs/world.md:
///         - agentIds start at 1 and never repeat;
///         - `setAgentWallet` requires a signature by the new wallet (ECDSA or ERC-1271) over an
///           EIP-712 digest in THIS contract's domain, which is not the official domain;
///         - the agent wallet is stored as metadata key "agentWallet" (value abi.encode(address));
///           every change, including the clear on transfer, emits MetadataSet so ERC-8434 resolvers can
///           reconstruct binding intervals;
///         - transfers clear the agent wallet.
interface IERC721ReceiverStub {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

interface IERC1271Stub {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4);
}

contract Identity8004Stub {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);

    string public constant name = "Identity8004Stub";
    string public constant symbol = "AGENT-STUB";
    string private constant AGENT_WALLET_KEY = "agentWallet";
    bytes32 private constant AGENT_WALLET_KEY_HASH = keccak256(bytes(AGENT_WALLET_KEY));
    bytes32 public constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operator;
    mapping(uint256 => string) private _agentURI;
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;
    mapping(uint256 => address) private _wallet;

    // ------------------------------------------------------------------ registration

    function register() external returns (uint256 agentId) {
        return _register("", new MetadataEntry[](0));
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        return _register(agentURI, new MetadataEntry[](0));
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        return _register(agentURI, metadata);
    }

    function _register(string memory agentURI, MetadataEntry[] memory metadata) private returns (uint256 agentId) {
        agentId = _nextId++;
        _owner[agentId] = msg.sender;
        _balance[msg.sender] += 1;
        _agentURI[agentId] = agentURI;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(_isApprovedOrOwner(msg.sender, agentId), "Identity8004Stub: not authorised");
        _agentURI[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        require(_owner[agentId] != address(0), "Identity8004Stub: unknown agent");
        return _agentURI[agentId];
    }

    function totalAgents() external view returns (uint256) {
        return _nextId - 1;
    }

    // ------------------------------------------------------------------ agent wallet

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallet[agentId];
    }

    /// @notice The new wallet must sign (ECDSA, or ERC-1271 for contract wallets) the digest of
    ///         AgentWalletSet(agentId, newWallet, owner, deadline) in this contract's EIP-712 domain.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external {
        require(_isApprovedOrOwner(msg.sender, agentId), "Identity8004Stub: not authorised");
        require(newWallet != address(0), "Identity8004Stub: zero wallet");
        require(block.timestamp <= deadline, "Identity8004Stub: expired");
        bytes32 digest = agentWalletDigest(agentId, newWallet, _owner[agentId], deadline);
        require(_validSignature(newWallet, digest, signature), "Identity8004Stub: bad wallet signature");
        _wallet[agentId] = newWallet;
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        require(_isApprovedOrOwner(msg.sender, agentId), "Identity8004Stub: not authorised");
        _clearWallet(agentId);
    }

    function agentWalletDigest(uint256 agentId, address newWallet, address owner, uint256 deadline) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, owner, deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _clearWallet(uint256 agentId) private {
        if (_wallet[agentId] != address(0)) {
            _wallet[agentId] = address(0);
            emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encode(address(0)));
        }
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSelector(IERC1271Stub.isValidSignature.selector, digest, signature));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271Stub.isValidSignature.selector;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        return ecrecover(digest, v, r, s) == signer;
    }

    // ------------------------------------------------------------------ metadata

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        bytes32 k = keccak256(bytes(metadataKey));
        if (k == AGENT_WALLET_KEY_HASH) {
            return _wallet[agentId] == address(0) ? bytes("") : abi.encode(_wallet[agentId]);
        }
        return _metadata[agentId][k];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        require(_isApprovedOrOwner(msg.sender, agentId), "Identity8004Stub: not authorised");
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) private {
        bytes32 k = keccak256(bytes(metadataKey));
        require(k != AGENT_WALLET_KEY_HASH, "Identity8004Stub: use setAgentWallet");
        _metadata[agentId][k] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    // ------------------------------------------------------------------ ERC-721 core

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "Identity8004Stub: zero owner");
        return _balance[owner];
    }

    function ownerOf(uint256 agentId) public view returns (address) {
        address o = _owner[agentId];
        require(o != address(0), "Identity8004Stub: unknown agent");
        return o;
    }

    function approve(address to, uint256 agentId) external {
        address o = ownerOf(agentId);
        require(msg.sender == o || _operator[o][msg.sender], "Identity8004Stub: not authorised");
        _approved[agentId] = to;
        emit Approval(o, to, agentId);
    }

    function getApproved(uint256 agentId) external view returns (address) {
        ownerOf(agentId);
        return _approved[agentId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operator[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operator[owner][operator];
    }

    function transferFrom(address from, address to, uint256 agentId) public {
        require(_isApprovedOrOwner(msg.sender, agentId), "Identity8004Stub: not authorised");
        require(_owner[agentId] == from, "Identity8004Stub: wrong from");
        require(to != address(0), "Identity8004Stub: transfer to zero");
        _clearWallet(agentId);
        delete _approved[agentId];
        _balance[from] -= 1;
        _balance[to] += 1;
        _owner[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    function safeTransferFrom(address from, address to, uint256 agentId) external {
        safeTransferFrom(from, to, agentId, "");
    }

    function safeTransferFrom(address from, address to, uint256 agentId, bytes memory data) public {
        transferFrom(from, to, agentId);
        if (to.code.length > 0) {
            require(
                IERC721ReceiverStub(to).onERC721Received(msg.sender, from, agentId, data) == IERC721ReceiverStub.onERC721Received.selector,
                "Identity8004Stub: receiver rejected"
            );
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function _isApprovedOrOwner(address spender, uint256 agentId) private view returns (bool) {
        address o = ownerOf(agentId);
        return spender == o || _approved[agentId] == spender || _operator[o][spender];
    }
}
