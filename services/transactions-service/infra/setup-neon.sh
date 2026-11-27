#!/usr/bin/env bash
# External database: Neon Postgres for the Transactions audit trail (enhancement 1b, Salma).
#
# Before the first run (once, by hand, nothing secret is ever written to a file):
#   1. In the Neon SQL Editor run neon-schema.sql (table + least-privilege role pb_transactions_app).
#   2. Store the connection string in Secrets Manager, typing the password where nobody sees it:
#        read -rsp "Password: " PB_PW; echo
#        read -rp "Host: " PB_HOST
#        aws --profile floci secretsmanager create-secret --name pb/neon-url \
#          --secret-string "postgresql://pb_transactions_app:${PB_PW}@${PB_HOST}/neondb?sslmode=require"
#        unset PB_PW PB_HOST
#
# What this script does (safe to run again; infra/deploy-floci.sh runs it automatically):
#   1. Checks the secret exists (if not, explains the steps above and stops without failing the deploy)
#   2. Encrypts the secret with the Transactions KMS key (alias/pb-transactions, see setup-kms.sh)
#   3. Lets ONLY the Transactions Lambda role read this one secret (least privilege)
#   4. Tells the Lambda the secret's name (NEON_SECRET_ID); the value itself never leaves Secrets Manager
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
cd "$(dirname "$0")" || exit 1

SECRET=pb/neon-url
ROLE=pb-transactions-role
FUNCTION=pb-transactions-api
REGION=us-east-1
ACCOUNT=000000000000
OUT=../../../out
mkdir -p $OUT

echo "1/4 Secret $SECRET in Secrets Manager"
if ! aws secretsmanager describe-secret --secret-id $SECRET > /dev/null 2>&1; then
  echo "  not found: the audit trail stays off. Create it as shown at the top of this script, then run it again."
  exit 0
fi

echo "2/4 Secret encrypted with the Transactions key"
aws secretsmanager update-secret --secret-id $SECRET --kms-key-id alias/pb-transactions > /dev/null \
  || echo "  (could not set the key: run setup-kms.sh first)"

echo "3/4 Only the Transactions Lambda role may read this secret"
sed -e "s|__REGION__|$REGION|g" -e "s|__ACCOUNT__|$ACCOUNT|g" neon-policy.json > $OUT/transactions-neon-policy.json
aws iam put-role-policy --role-name $ROLE --policy-name pb-transactions-neon \
  --policy-document file://$OUT/transactions-neon-policy.json || exit 1

echo "4/4 Tell the Transactions Lambda where the connection string is"
# Lambda replaces ALL its settings on update, so read the current ones and add ours
aws lambda get-function-configuration --function-name $FUNCTION --query Environment.Variables --output json \
  > $OUT/transactions-env.json || exit 1
node -e "
  const fs = require('fs');
  const f = process.argv[1];
  const vars = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  vars.NEON_SECRET_ID = process.argv[2];
  fs.writeFileSync(f, JSON.stringify({ Variables: vars }));
" "$OUT/transactions-env.json" "$SECRET" || exit 1
aws lambda update-function-configuration --function-name $FUNCTION \
  --environment file://$OUT/transactions-env.json > /dev/null || exit 1
aws lambda wait function-updated-v2 --function-name $FUNCTION
rm -f $OUT/transactions-env.json

echo
echo "Proof (no secret value is printed):"
echo "  secret name and key:"
aws secretsmanager describe-secret --secret-id $SECRET --query "[Name,KmsKeyId]" --output text
echo "  role policy:"
aws iam get-role-policy --role-name $ROLE --policy-name pb-transactions-neon --query "PolicyDocument.Statement[0].Resource" --output text
echo "  Lambda setting:"
aws lambda get-function-configuration --function-name $FUNCTION --query Environment.Variables.NEON_SECRET_ID --output text
