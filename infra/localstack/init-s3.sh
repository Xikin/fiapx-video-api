#!/bin/sh
# Cria o bucket do ambiente local e libera CORS para o navegador enviar e baixar direto.
set -eu
BUCKET="${S3_BUCKET:-fiapx-videos}"
awslocal s3 mb "s3://${BUCKET}" 2>/dev/null || true
awslocal s3api put-bucket-cors --bucket "${BUCKET}" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:8080"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'
echo "bucket ${BUCKET} pronto"
