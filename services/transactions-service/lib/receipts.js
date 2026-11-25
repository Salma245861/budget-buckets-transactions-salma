// Receipt files in a PRIVATE Amazon S3 bucket (RECEIPTS_BUCKET, Block Public Access ON,
// server-side encryption ON). The browser never gets AWS credentials: it receives a pre-signed
// URL that allows ONE operation on ONE object for 5 minutes.
//   object key = receipts/<userId>/<transactionId>  -> a user can only ever get a URL for their own key
const URL_TTL_SEC = 300;

let clients = null;
function getClients() {
  if (clients) return clients;
  const { S3Client } = require('@aws-sdk/client-s3');
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  // On Floci the Lambda reaches S3 at an internal address; the browser needs the public one.
  const signer = process.env.S3_PUBLIC_ENDPOINT
    ? new S3Client({ endpoint: process.env.S3_PUBLIC_ENDPOINT, forcePathStyle: true })
    : new S3Client({ forcePathStyle });
  clients = { s3: new S3Client({ forcePathStyle }), signer };
  return clients;
}

const enabled = () => Boolean(process.env.RECEIPTS_BUCKET);
const keyFor = (userId, txnId) => `receipts/${userId}/${txnId}`;

async function uploadUrl(key, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getClients().signer, new PutObjectCommand({
    Bucket: process.env.RECEIPTS_BUCKET, Key: key, ContentType: contentType
  }), { expiresIn: URL_TTL_SEC });
}

async function downloadUrl(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getClients().signer, new GetObjectCommand({
    Bucket: process.env.RECEIPTS_BUCKET, Key: key
  }), { expiresIn: URL_TTL_SEC });
}

async function removeObject(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await getClients().s3.send(new DeleteObjectCommand({ Bucket: process.env.RECEIPTS_BUCKET, Key: key }));
}

module.exports = { enabled, keyFor, uploadUrl, downloadUrl, removeObject, URL_TTL_SEC };
