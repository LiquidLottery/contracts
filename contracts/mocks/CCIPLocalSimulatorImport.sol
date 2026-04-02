// SPDX-License-Identifier: MIT
// This file exists solely to make Hardhat compile and expose the
// CCIPLocalSimulator artifact for use in test fixtures.
// It must not be deployed to production networks.
pragma solidity ^0.8.19;

import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
