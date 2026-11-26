#!/usr/bin/env bash
# Shared exchange-rate cache for the Transactions service (enhancement B, Salma).
# The cache lives in the service's own table (pk FXCACHE#shared, sk RATES#<currency>), so it needs
# no new AWS service on Floci. This script turns on DynamoDB Time To Live, which deletes cache rows
# after their "expiresAt" time, so old rates never pile up. Safe to run again.
#   bash services/transactions-service/infra/setup-fx-cache.sh
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
TABLE=PBTransactions

echo "Time To Live on $TABLE (attribute expiresAt)"
STATUS=$(aws dynamodb describe-time-to-live --table-name $TABLE --query TimeToLiveDescription.TimeToLiveStatus --output text 2>/dev/null)
if [ "$STATUS" != "ENABLED" ]; then
  aws dynamodb update-time-to-live --table-name $TABLE \
    --time-to-live-specification "Enabled=true,AttributeName=expiresAt" > /dev/null || exit 1
fi

echo
echo "Proof:"
aws dynamodb describe-time-to-live --table-name $TABLE --query "TimeToLiveDescription.[TimeToLiveStatus,AttributeName]" --output text
echo "  cached currencies right now:"
aws dynamodb query --table-name $TABLE --key-condition-expression "pk = :p" \
  --expression-attribute-values '{":p":{"S":"FXCACHE#shared"}}' \
  --query "Items[].[sk.S, provider.S, updated.S]" --output text
