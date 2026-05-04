// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title TickerLib
/// @notice Pure helpers for normalising and hashing token tickers as defined by spec §4.6.1.
///         Centralised here so the on-chain `FilterLauncher.reserve` path, the
///         `SeasonVault.submitWinner` cross-season reservation, and the off-chain UI tx-prep
///         (via a TS port) all derive the same canonical hash from a user-supplied string.
///
///         Normalisation rules (in order — audit: bugbot M PR #88 — the order MUST match
///         the implementation exactly so the off-chain TS port produces identical hashes):
///           1. Trim ASCII whitespace (` \t\n\r`) from both ends. This runs FIRST so a
///              user paste like `" $FILTER "` (paste with leading/trailing spaces) yields
///              the same canonical form as `"$FILTER"`.
///           2. Drop a single leading `$` if present (UX convention; AFTER trim, so the
///              `$` only counts as "leading" once whitespace has been removed). Inputs
///              like `"$ PEPE"` (a space immediately after `$`) are NOT accepted: the
///              `$`-strip leaves `" PEPE"`, the inner space is not stripped (only outer
///              trims run), and the format validator below rejects on the inner space.
///           3. Uppercase ASCII letters; non-ASCII bytes pass through and trip the format
///              validator below (so a homograph like Cyrillic `Е` (U+0415) is rejected at
///              format time, never silently accepted as `E`).
///           4. Validate the result matches `^[A-Z0-9]{2,10}$`. Empty / single-char /
///              over-length / punctuation / lowercase-leftover (impossible after step 3) all
///              revert `InvalidTickerFormat`.
///
///         The hash is `keccak256(bytes(normalize(ticker)))`. The pre-image is the normalised
///         ASCII ticker so the hash is stable across (a) submitting `$Filter` vs `filter` vs
///         `FILTER` (b) re-encoding by an upstream service. Off-chain code MUST mirror this
///         exact pipeline.
library TickerLib {
    error InvalidTickerFormat(string ticker);

    /// @notice Normalises `ticker` per the rules above and returns the canonical form.
    /// @dev    Reverts `InvalidTickerFormat` when the result is outside `^[A-Z0-9]{2,10}$`.
    ///         This includes any non-ASCII byte sequence — the validator runs on the post-
    ///         strip/post-uppercase bytes, so homograph attacks like Cyrillic `Е` (0xD0 0x95
    ///         in UTF-8) are rejected here rather than slipping into uniqueness checks where
    ///         they could collide-but-not-collide with the ASCII `E`.
    function normalize(string memory ticker) external pure returns (string memory) {
        bytes memory raw = bytes(ticker);
        uint256 n = raw.length;

        // Trim leading whitespace.
        uint256 start = 0;
        while (start < n && _isAsciiWhitespace(raw[start])) {
            ++start;
        }
        // Trim trailing whitespace.
        uint256 end = n;
        while (end > start && _isAsciiWhitespace(raw[end - 1])) {
            --end;
        }

        // Drop a single leading `$` after whitespace trim.
        if (end > start && raw[start] == 0x24) {
            ++start;
        }

        uint256 trimmedLen = end - start;
        // Length pre-check for the {2,10} bound — uppercasing only changes case, not length.
        if (trimmedLen < 2 || trimmedLen > 10) revert InvalidTickerFormat(ticker);

        bytes memory out = new bytes(trimmedLen);
        for (uint256 i = 0; i < trimmedLen; ++i) {
            bytes1 b = raw[start + i];
            // Uppercase ASCII a-z (0x61..0x7A) → A-Z (0x41..0x5A).
            if (b >= 0x61 && b <= 0x7A) {
                b = bytes1(uint8(b) - 32);
            }
            // Validate against [A-Z0-9]. Anything else (non-ASCII high bit, punctuation,
            // remaining whitespace inside the string, the second `$`, etc.) reverts.
            bool isUpper = (b >= 0x41 && b <= 0x5A);
            bool isDigit = (b >= 0x30 && b <= 0x39);
            if (!isUpper && !isDigit) revert InvalidTickerFormat(ticker);
            out[i] = b;
        }

        return string(out);
    }

    /// @dev ASCII whitespace per `^[ \t\r\n]$`. Deliberately not Unicode-aware; non-ASCII
    ///      whitespace would fall through and trip the format validator.
    function _isAsciiWhitespace(bytes1 b) private pure returns (bool) {
        return b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D;
    }
}
