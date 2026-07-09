#!/usr/bin/env bash
# =====================================================================================
# filter.fun — testnet deploy orchestrator (Robinhood Chain testnet 46630 by default;
# Base Sepolia 84532 kept as the retreat path — 2026-07 retarget).
#
# Chains: idempotency check → DeployTestnet.s.sol → verification per contract
#   (Blockscout on Robinhood, Basescan on Base Sepolia)
#   → optionally SeedFilter.s.sol (gated on --seed-filter flag).
#
# Run from packages/contracts/:
#   ./script/deploy-testnet.sh                                # robinhood-testnet deploy
#   ./script/deploy-testnet.sh --network base-sepolia         # legacy target
#   ./script/deploy-testnet.sh --seed-filter                  # + SeedFilter (after oracle startSeason)
#   ./script/deploy-testnet.sh --force-redeploy
#
# Or via the workspace alias: `npm --workspace @filter-fun/contracts run deploy:testnet`.
#
# Robinhood testnet has no canonical Uniswap v4 / WETH9 — run DeployTestnetInfra.s.sol
# first and put its printed addresses into .env.robinhood-testnet.
#
# Loads `.env.<network>` from the package root if present.
# =====================================================================================
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = packages/contracts/

NETWORK="robinhood-testnet"
SEED_FILTER=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --network=*) NETWORK="${1#*=}"; shift ;;
    --seed-filter) SEED_FILTER=1; shift ;;
    --force-redeploy) FORCE=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

case "$NETWORK" in
  robinhood-testnet)
    RPC_VAR="ROBINHOOD_TESTNET_RPC_URL"
    # Blockscout: no API key; forge talks to the etherscan-v1-compatible /api endpoint.
    VERIFIER="blockscout"
    VERIFIER_URL="https://explorer.testnet.chain.robinhood.com/api/"
    ;;
  base-sepolia)
    RPC_VAR="BASE_SEPOLIA_RPC_URL"
    VERIFIER="etherscan"
    VERIFIER_URL=""
    ;;
  *) echo "unsupported --network: $NETWORK (want robinhood-testnet or base-sepolia)"; exit 2 ;;
esac

ENV_FILE=".env.${NETWORK}"
MANIFEST="deployments/${NETWORK}.json"

# ----- Load env ---------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "warning: $ENV_FILE not found; relying on already-exported env vars"
fi

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY required}"
RPC_URL="${!RPC_VAR:?$RPC_VAR required}"
: "${V4_POOL_MANAGER_ADDRESS:?V4_POOL_MANAGER_ADDRESS required}"
: "${WETH_ADDRESS:?WETH_ADDRESS required}"
: "${TREASURY_OWNER:?TREASURY_OWNER required}"
: "${SCHEDULER_ORACLE_ADDRESS:?SCHEDULER_ORACLE_ADDRESS required}"
: "${REFUNDABLE_STAKE_ENABLED:?REFUNDABLE_STAKE_ENABLED required}"

# Capture the deploy commit so the manifest can prove which source was deployed.
export DEPLOY_COMMIT_HASH="${DEPLOY_COMMIT_HASH:-$(git rev-parse HEAD)}"
if [[ "$FORCE" == "1" ]]; then export FORCE_REDEPLOY=1; fi

# ----- Idempotency check ------------------------------------------------------------
# DeployTestnet.s.sol also checks this, but a friendly bail at the shell layer avoids
# the 5-second forge boot when the operator just forgot they already deployed.
if [[ -f "$MANIFEST" && "${FORCE_REDEPLOY:-0}" != "1" ]]; then
  prior_launcher=$(jq -r '.addresses.filterLauncher // ""' "$MANIFEST" 2>/dev/null || echo "")
  if [[ -n "$prior_launcher" && "$prior_launcher" != "0x0000000000000000000000000000000000000000" ]]; then
    echo "manifest already populated: $MANIFEST"
    echo "  prior FilterLauncher: $prior_launcher"
    echo "  re-run with --force-redeploy or 'rm $MANIFEST' to redeploy."
    exit 1
  fi
fi

echo "=== Step 1/3: forge script DeployTestnet ($NETWORK) ==="
forge script script/DeployTestnet.s.sol:DeployTestnet \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  -vvv

# ----- Manifest startBlock sanity (bugbot H PR #105) ---------------------------------
# On Arbitrum-family chains, contract-EVM `block.number` is the L1 ancestor height —
# a manifest carrying it would point Ponder's startBlock far above the L2 tip and the
# indexer would silently never sync. ManifestWriter queries eth_blockNumber directly,
# but this tripwire makes the failure loud if any regression reintroduces the trap.
CURRENT_BLOCK=$(cast block-number -r "$RPC_URL")
MANIFEST_BLOCK=$(jq -r '.deployBlockNumber' "$MANIFEST")
if (( MANIFEST_BLOCK > CURRENT_BLOCK )); then
  echo "FATAL: manifest deployBlockNumber ($MANIFEST_BLOCK) exceeds the chain tip ($CURRENT_BLOCK)."
  echo "  This is the Arbitrum L1-vs-L2 block-number trap — the indexer would never sync."
  echo "  Fix ManifestWriter._deployBlockNumber, correct the manifest by hand, and re-verify."
  exit 1
fi
echo "manifest startBlock sanity: $MANIFEST_BLOCK <= tip $CURRENT_BLOCK ✓"

# ----- Verify ------------------------------------------------------------------------
echo "=== Step 2/3: forge verify-contract per deployed contract ==="
SKIP_VERIFY=0
if [[ "$VERIFIER" == "etherscan" && -z "${BASESCAN_API_KEY:-}" ]]; then
  echo "BASESCAN_API_KEY not set — skipping verification."
  SKIP_VERIFY=1
fi

if [[ "$SKIP_VERIFY" != "1" ]]; then
  # Read the freshly written manifest.
  T=$(jq -r '.addresses.treasuryTimelock'    "$MANIFEST")
  B=$(jq -r '.addresses.bonusDistributor'    "$MANIFEST")
  V=$(jq -r '.addresses.polVault'            "$MANIFEST")
  CP=$(jq -r '.addresses.filterClubPass'     "$MANIFEST")
  L=$(jq -r '.addresses.filterLauncher'      "$MANIFEST")
  M=$(jq -r '.addresses.polManager'          "$MANIFEST")
  H=$(jq -r '.addresses.filterHook'          "$MANIFEST")
  F=$(jq -r '.addresses.filterFactory'       "$MANIFEST")
  CR=$(jq -r '.addresses.creatorRegistry'    "$MANIFEST")
  CFD=$(jq -r '.addresses.creatorFeeDistributor' "$MANIFEST")
  CC=$(jq -r '.addresses.creatorCommitments' "$MANIFEST")
  TR=$(jq -r '.addresses.tournamentRegistry' "$MANIFEST")
  TV=$(jq -r '.addresses.tournamentVault'    "$MANIFEST")
  CLUB_PRICE=$(jq -r '.config.filterClubMintPriceWei' "$MANIFEST")
  CLUB_SUPPLY=$(jq -r '.config.filterClubMaxSupply'   "$MANIFEST")

  # Capture the deployer EOA address ONCE so we don't re-evaluate `cast wallet address
  # --private-key "$DEPLOYER_PRIVATE_KEY"` per command (each evaluation is a chance to
  # leak the key in error output or accidental tracing).
  DEPLOYER_ADDR="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"

  # Common verify flags. We deliberately do NOT enable `set -x` for verification: bash's
  # xtrace prints fully-expanded commands to stderr, and any line referencing
  # `--etherscan-api-key "$BASESCAN_API_KEY"` would dump the API key into CI logs (where
  # they're persisted indefinitely). The earlier draft did this; bugbot caught it.
  # Without xtrace, every call below logs only via the per-contract echo lines, which
  # contain just the contract address.
  if [[ "$VERIFIER" == "blockscout" ]]; then
    COMMON="--verifier blockscout --verifier-url $VERIFIER_URL --watch --skip-is-verified-check"
  else
    COMMON="--chain base_sepolia --etherscan-api-key $BASESCAN_API_KEY --watch --skip-is-verified-check"
  fi

  # Reconstruct the constructor args foundry-style. Each call shape mirrors the deploy
  # in DeployTestnet.s.sol — keep these in lockstep when changing constructors.
  echo "  verify TreasuryTimelock:    $T"
  forge verify-contract "$T"  src/TreasuryTimelock.sol:TreasuryTimelock $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address[],address[],address)' \
      "[$TREASURY_OWNER]" "[$TREASURY_OWNER]" "$TREASURY_OWNER")"

  echo "  verify BonusDistributor:    $B"
  forge verify-contract "$B" src/BonusDistributor.sol:BonusDistributor $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
      "$DEPLOYER_ADDR" "$WETH_ADDRESS" "$SCHEDULER_ORACLE_ADDRESS")"

  echo "  verify POLVault:            $V"
  forge verify-contract "$V" src/POLVault.sol:POLVault $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address)' "$DEPLOYER_ADDR")"

  # Epic 2.6 — Filter Club lifetime pass (deployed before the launcher).
  echo "  verify FilterClubPass:      $CP"
  forge verify-contract "$CP" src/FilterClubPass.sol:FilterClubPass $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,string,uint256,uint256,uint32)' \
      "$DEPLOYER_ADDR" "${FILTER_CLUB_PAYOUT:-$T}" "${FILTER_CLUB_BASE_URI:-https://filter.fun/api/club/meta/}" \
      "$CLUB_SUPPLY" "$CLUB_PRICE" "${FILTER_CLUB_WALLET_CAP:-5}")"

  echo "  verify FilterLauncher:      $L"
  forge verify-contract "$L" src/FilterLauncher.sol:FilterLauncher $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address)' \
      "$DEPLOYER_ADDR" "$SCHEDULER_ORACLE_ADDRESS" "$T" \
      "${MECHANICS_WALLET:-$TREASURY_OWNER}" "$B" "$WETH_ADDRESS" "$CP")"

  echo "  verify POLManager:          $M"
  forge verify-contract "$M" src/POLManager.sol:POLManager $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
      "$L" "$WETH_ADDRESS" "$V")"

  # FilterHook constructor is no-arg.
  echo "  verify FilterHook:          $H"
  forge verify-contract "$H" src/FilterHook.sol:FilterHook $COMMON

  echo "  verify FilterFactory:       $F"
  forge verify-contract "$F" src/FilterFactory.sol:FilterFactory $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address)' \
      "$V4_POOL_MANAGER_ADDRESS" "$H" "$L" "$WETH_ADDRESS" "$CFD" "$M" "$CC")"

  # CreatorRegistry / CreatorFeeDistributor / CreatorCommitments / TournamentRegistry /
  # TournamentVault are inline-deployed by FilterLauncher. Operators can verify these via
  # the explorer UI given the source is identical.
  echo "Note: CR/CFD/CC/TR/TV inline-deployed; verify via the explorer UI if needed:"
  echo "  CreatorRegistry:        $CR"
  echo "  CreatorFeeDistributor:  $CFD"
  echo "  CreatorCommitments:     $CC"
  echo "  TournamentRegistry:     $TR"
  echo "  TournamentVault:        $TV"
fi

# ----- Optional $FILTER seed --------------------------------------------------------
if [[ "$SEED_FILTER" == "1" ]]; then
  echo "=== Step 3/3: forge script SeedFilter ==="
  : "${FILTER_METADATA_URI:?FILTER_METADATA_URI required for --seed-filter}"
  forge script script/SeedFilter.s.sol:SeedFilter \
    --rpc-url "$RPC_URL" \
    --broadcast \
    -vvv
else
  echo "=== Step 3/3: SeedFilter skipped ==="
  echo "  Run with --seed-filter once the oracle has called launcher.startSeason()"
  echo "  (or invoke directly: forge script script/SeedFilter.s.sol --rpc-url \$$RPC_VAR --broadcast)"
fi

echo
echo "Done. Manifest: $MANIFEST"
