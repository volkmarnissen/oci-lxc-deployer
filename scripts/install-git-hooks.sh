#!/bin/sh
# Install Git hooks for the lxc-manager project
# This script copies the pre-push hook from scripts/git-hooks to .git/hooks

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
SOURCE_HOOKS_DIR="$SCRIPT_DIR/git-hooks"

# Check if .git directory exists
if [ ! -d "$PROJECT_ROOT/.git" ]; then
  echo "${YELLOW}Warning: .git directory not found. Not a git repository?${NC}"
  echo "${YELLOW}Skipping git hooks installation.${NC}"
  exit 0
fi

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Install pre-push hook
if [ -f "$SOURCE_HOOKS_DIR/pre-push" ]; then
  echo "Installing pre-push hook..."
  cp "$SOURCE_HOOKS_DIR/pre-push" "$HOOKS_DIR/pre-push"
  chmod +x "$HOOKS_DIR/pre-push"
  echo "${GREEN}✓ pre-push hook installed${NC}"
else
  echo "${YELLOW}Warning: pre-push hook not found in $SOURCE_HOOKS_DIR${NC}"
fi

echo ""
echo "${GREEN}Git hooks installation complete!${NC}"
echo ""
echo "The pre-push hook will:"
echo "  1. Sync GitHub repository with upstream (if gh is installed)"
echo "  2. Update main branch to latest origin/main"
echo "  3. Merge main into your current branch"
echo "  4. Abort push if merge conflicts occur (you can resolve them manually)"
echo ""
echo "To skip the hook temporarily: git push --no-verify"
