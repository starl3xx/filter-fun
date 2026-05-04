#!/usr/bin/env bash
# =====================================================================================
# filter.fun — Base Sepolia deploy orchestrator.
#
# Chains: idempotency check → DeploySepolia.s.sol → forge verify-contract per contract
#   → optionally SeedFilter.s.sol (gated on --seed-filter flag).
#
# Run from packages/contracts/:
#   ./script/deploy-sepolia.sh              # deploy only
#   ./script/deploy-sepolia.sh --seed-filter # deploy + run SeedFilter (after oracle startSeason)
#   FORCE_REDEPLOY=1 ./script/deploy-sepolia.sh --force-redeploy
#
# Or via the workspace alias: `npm --workspace @filter-fun/contracts run deploy:sepolia`.
#
# Loads `.env.sepolia` from the package root if present.
# =====================================================================================
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = packages/contracts/

ENV_FILE=".env.sepolia"
MANIFEST="deployments/base-sepolia.json"
SEED_FILTER=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --seed-filter) SEED_FILTER=1 ;;
    --force-redeploy) FORCE=1 ;;
    *) echo "unknown arg: $arg"; exit 2 ;;
  esac
done

# ----- Load env ---------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "warning: $ENV_FILE not found; relying on already-exported env vars"
fi

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY required}"
: "${BASE_SEPOLIA_RPC_URL:?BASE_SEPOLIA_RPC_URL required}"
: "${V4_POOL_MANAGER_ADDRESS:?V4_POOL_MANAGER_ADDRESS required}"
: "${WETH_ADDRESS:?WETH_ADDRESS required}"
: "${TREASURY_OWNER:?TREASURY_OWNER required}"
: "${SCHEDULER_ORACLE_ADDRESS:?SCHEDULER_ORACLE_ADDRESS required}"
# Spec §46 deferred-activation: per-wallet cap is enforced structurally by LaunchEscrow.
# `MAX_LAUNCHES_PER_WALLET` is no longer required (the deploy script ignores it). Kept
# as an accepted-and-ignored knob for one release so existing operator env files don't
# break — clean up after Sepolia drift validates.
: "${REFUNDABLE_STAKE_ENABLED:?REFUNDABLE_STAKE_ENABLED required}"

# Capture the deploy commit so the manifest can prove which source was deployed.
export DEPLOY_COMMIT_HASH="${DEPLOY_COMMIT_HASH:-$(git rev-parse HEAD)}"
if [[ "$FORCE" == "1" ]]; then export FORCE_REDEPLOY=1; fi

# ----- Idempotency check ------------------------------------------------------------
# DeploySepolia.s.sol also checks this, but a friendly bail at the shell layer avoids
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

echo "=== Step 1/3: forge script DeploySepolia ==="
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast \
  --slow \
  -vvv

# ----- Verify on Basescan ------------------------------------------------------------
echo "=== Step 2/3: forge verify-contract per deployed contract ==="
if [[ -z "${BASESCAN_API_KEY:-}" ]]; then
  echo "BASESCAN_API_KEY not set — skipping verification."
else
  # Read the freshly written manifest.
  T=$(jq -r '.addresses.treasuryTimelock'    "$MANIFEST")
  B=$(jq -r '.addresses.bonusDistributor'    "$MANIFEST")
  V=$(jq -r '.addresses.polVault'            "$MANIFEST")
  L=$(jq -r '.addresses.filterLauncher'      "$MANIFEST")
  M=$(jq -r '.addresses.polManager'          "$MANIFEST")
  H=$(jq -r '.addresses.filterHook'          "$MANIFEST")
  F=$(jq -r '.addresses.filterFactory'       "$MANIFEST")
  CR=$(jq -r '.addresses.creatorRegistry'    "$MANIFEST")
  CFD=$(jq -r '.addresses.creatorFeeDistributor' "$MANIFEST")
  TR=$(jq -r '.addresses.tournamentRegistry' "$MANIFEST")
  TV=$(jq -r '.addresses.tournamentVault'    "$MANIFEST")

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
  CHAIN_FLAG="--chain base_sepolia"
  COMMON="$CHAIN_FLAG --etherscan-api-key $BASESCAN_API_KEY --watch --skip-is-verified-check"

  # Reconstruct the constructor args foundry-style. Each call shape mirrors the deploy
  # in DeploySepolia.s.sol — keep these in lockstep when changing constructors.
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

  echo "  verify FilterLauncher:      $L"
  forge verify-contract "$L" src/FilterLauncher.sol:FilterLauncher $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address)' \
      "$DEPLOYER_ADDR" "$SCHEDULER_ORACLE_ADDRESS" "$T" \
      "${MECHANICS_WALLET:-$TREASURY_OWNER}" "$B" "$WETH_ADDRESS")"

  echo "  verify POLManager:          $M"
  forge verify-contract "$M" src/POLManager.sol:POLManager $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
      "$L" "$WETH_ADDRESS" "$V")"

  # FilterHook constructor is no-arg.
  echo "  verify FilterHook:          $H"
  forge verify-contract "$H" src/FilterHook.sol:FilterHook $COMMON

  echo "  verify FilterFactory:       $F"
  forge verify-contract "$F" src/FilterFactory.sol:FilterFactory $COMMON \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address)' \
      "$V4_POOL_MANAGER_ADDRESS" "$H" "$L" "$WETH_ADDRESS" "$CFD" "$M")"

  # CreatorRegistry / CreatorFeeDistributor / TournamentRegistry / TournamentVault are
  # inline-deployed by FilterLauncher. We verify them by looking up the on-chain bytecode
  # against the in-source artifact — no separate constructor args here are practical to
  # pass, so we leave a TODO. Operators can verify these via the basescan UI given the
  # source is identical.
  echo "Note: CR/CFD/TR/TV inline-deployed; verify via Basescan UI if needed:"
  echo "  CreatorRegistry:        $CR"
  echo "  CreatorFeeDistributor:  $CFD"
  echo "  TournamentRegistry:     $TR"
  echo "  TournamentVault:        $TV"
fi

# ----- Optional $FILTER seed --------------------------------------------------------
if [[ "$SEED_FILTER" == "1" ]]; then
  echo "=== Step 3/3: forge script SeedFilter ==="
  : "${FILTER_METADATA_URI:?FILTER_METADATA_URI required for --seed-filter}"
  forge script script/SeedFilter.s.sol:SeedFilter \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" \
    --broadcast \
    -vvv
else
  echo "=== Step 3/3: SeedFilter skipped ==="
  echo "  Run with --seed-filter once the oracle has called launcher.startSeason()"
  echo "  (or invoke directly: forge script script/SeedFilter.s.sol --rpc-url \$BASE_SEPOLIA_RPC_URL --broadcast)"
fi

echo
echo "Done. Manifest: $MANIFEST"
