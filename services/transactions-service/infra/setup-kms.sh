#!/usr/bin/env bash
# Customer-managed encryption key for the Transactions service (enhancement A, Salma).
#
# Why: by default AWS encrypts data with a key AWS owns. A customer-managed KMS key is ours:
# we decide who may use it, it rotates automatically, every use can be audited, and disabling it
# makes the data unreadable at once (a "kill switch" after a compromise).
#
# What it does (safe to run again):
#   1. Creates (or reuses) the KMS key alias/pb-transactions and turns on yearly rotation
#   2. Encrypts the PBTransactions DynamoDB table with it
#   3. Makes it the default encryption of the private receipts bucket
#   4. Lets ONLY the Transactions Lambda role use this one key (least privilege)
#   5. Gives the Lambda the key (RECEIPTS_KMS_KEY), so every receipt file asks for it explicitly
#   6. Prints the proof
#
# Run AFTER infra/deploy-floci.sh (that script resets the bucket to AES256):
#   bash services/transactions-service/infra/setup-kms.sh
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
cd "$(dirname "$0")" || exit 1

ALIAS=alias/pb-transactions
TABLE=PBTransactions
BUCKET=pb-receipts-244694
ROLE=pb-transactions-role
FUNCTION=pb-transactions-api

echo "1/5 KMS key $ALIAS"
KEY_ID=$(aws kms describe-key --key-id $ALIAS --query KeyMetadata.KeyId --output text 2>/dev/null)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
  KEY_ID=$(aws kms create-key --description "Personal Budget Buckets - Transactions data and receipts" \
    --tags TagKey=Project,TagValue=personal-budget-buckets TagKey=Owner,TagValue=salma-amir \
    --query KeyMetadata.KeyId --output text) || exit 1
  aws kms create-alias --alias-name $ALIAS --target-key-id "$KEY_ID" || exit 1
fi
KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)
aws kms enable-key-rotation --key-id "$KEY_ID"
echo "  key $KEY_ID"

echo "2/5 DynamoDB table $TABLE encrypted with the key"
aws dynamodb update-table --table-name $TABLE \
  --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=$KEY_ARN" > /dev/null \
  || echo "  (already set, or not supported by this Floci version: note it as a limitation)"

echo "3/5 Receipts bucket $BUCKET encrypted with the key by default"
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$KEY_ARN\"},\"BucketKeyEnabled\":true}]}" || exit 1

echo "4/5 Only the Transactions Lambda role may use this key"
mkdir -p ../../../out
sed "s|__KEY_ARN__|$KEY_ARN|" kms-policy.json > ../../../out/transactions-kms-policy.json
aws iam put-role-policy --role-name $ROLE --policy-name pb-transactions-kms \
  --policy-document file://../../../out/transactions-kms-policy.json || exit 1

echo "5/5 Tell the Transactions Lambda to encrypt every receipt with this key"
# Lambda replaces ALL its settings on update, so read the current ones and add ours
aws lambda get-function-configuration --function-name $FUNCTION --query Environment.Variables --output json \
  > ../../../out/transactions-env.json || exit 1
node -e "
  const fs = require('fs');
  const f = '../../../out/transactions-env.json';
  const vars = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  vars.RECEIPTS_KMS_KEY = process.argv[1];
  fs.writeFileSync(f, JSON.stringify({ Variables: vars }));
" "$KEY_ARN" || exit 1
aws lambda update-function-configuration --function-name $FUNCTION \
  --environment file://../../../out/transactions-env.json > /dev/null || exit 1
aws lambda wait function-updated-v2 --function-name $FUNCTION

echo
echo "Proof:"
echo "  key state and rotation:"
aws kms describe-key --key-id $ALIAS --query "KeyMetadata.[KeyId,KeyState,KeyManager]" --output text
aws kms get-key-rotation-status --key-id "$KEY_ID" --query KeyRotationEnabled --output text
echo "  table encryption:"
aws dynamodb describe-table --table-name $TABLE --query "Table.SSEDescription.[Status,SSEType,KMSMasterKeyArn]" --output text
echo "  bucket encryption:"
aws s3api get-bucket-encryption --bucket $BUCKET \
  --query "ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.[SSEAlgorithm,KMSMasterKeyID]" --output text
echo "  role policy:"
aws iam get-role-policy --role-name $ROLE --policy-name pb-transactions-kms --query "PolicyDocument.Statement[0].Resource" --output text
echo "  Lambda setting:"
aws lambda get-function-configuration --function-name $FUNCTION --query Environment.Variables.RECEIPTS_KMS_KEY --output text
