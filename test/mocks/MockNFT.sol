// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";

contract MockNFT is ERC721, ERC2981 {
    constructor() ERC721("Mock NFT", "MOCK") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setRoyalty(address receiver, uint96 bps) external {
        _setDefaultRoyalty(receiver, bps);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }
}

/// @dev Rejects plain ETH transfers.
contract RejectETH {}
