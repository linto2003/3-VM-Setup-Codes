#!/bin/bash

set -e

# ==============================================================================
# Deployment Script for EduDigiKagadPatra Chaincode
# Make sure to run this script on your VM where the Fabric network is hosted.
# ==============================================================================

# 1. Path to your test-network (based on your Node SDK .env)
NETWORK_DIR="/root/hr_digikagadpatra/fabric-samples/test-network"

# 2. Path to where you copied this chaincode folder on the VM
# (If you run this script from inside the chaincode folder, $PWD works perfectly)
CHAINCODE_DIR=$PWD

# 3. Chaincode Name
CHAINCODE_NAME="hr-chaincode"

# 4. Chaincode Language
CHAINCODE_LANG="javascript"

echo "=========================================================="
echo "Deploying Chaincode: $CHAINCODE_NAME"
echo "From path: $CHAINCODE_DIR"
echo "To network: $NETWORK_DIR"
echo "=========================================================="

# Ensure we are passing the correct absolute path
cd $NETWORK_DIR

# 5. Run the standard Fabric test-network deployment script
# Note: This will package, install, approve, and commit the chaincode.
# There is NO explicitly required initialization function for this chaincode!
./network.sh deployCCAAS -ccn $CHAINCODE_NAME -ccv 1.1 -ccs 6 -ccp $CHAINCODE_DIR -ccl $CHAINCODE_LANG

echo "=========================================================="
echo "Deployment Complete!"
echo "If successful, the Node SDK can now connect to '$CHAINCODE_NAME'"
echo "=========================================================="
