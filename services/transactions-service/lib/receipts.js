// Receipt files in a PRIVATE Amazon S3 bucket (RECEIPTS_BUCKET, Block Public Access ON,
// server-side encryption ON). The browser never gets AWS credentials.
//   object key = receipts/<userId>/<transactionId>  -> a user can only ever get a link for their own key
//
// Safe uploads (enhancement 5e, Salma):
//   1. Size cap: the browser gets a pre-signed POST form whose policy says
//      "1 byte to 5 MB, and exactly this Content-Type". S3 itself refuses anything else,
//      so a huge file never reaches our storage (EntityTooLarge / AccessDenied).
//   2. Real type check: the upload goes to a waiting spot (<key>.pending). The service reads the
//      file's first bytes and checks they really are a JPEG, PNG or PDF. Only then is it moved to
//      the real spot. A program renamed to photo.jpg is deleted, and an existing receipt is kept.
const URL_TTL_SEC = 300;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

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
// Customer-managed KMS key (enhancement A). Asked for explicitly on every write, so files are
// encrypted with our key even where the bucket default is not applied (Floci).
const kmsKey = () => process.env.RECEIPTS_KMS_KEY || null;
const kmsParams = () => (kmsKey() ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKey() } : {});
const keyFor = (userId, txnId) => `receipts/${userId}/${txnId}`;
// New uploads land here first, so a rejected file never replaces a good receipt
const pendingKeyFor = (userId, txnId) => `${keyFor(userId, txnId)}.pending`;

// A checked upload is moved from the waiting spot to the real spot
async function promote(pendingKey, finalKey) {
  const { CopyObjectCommand } = require('@aws-sdk/client-s3');
  const Bucket = process.env.RECEIPTS_BUCKET;
  await getClients().s3.send(new CopyObjectCommand({
    Bucket, Key: finalKey, CopySource: `${Bucket}/${pendingKey.split('/').map(encodeURIComponent).join('/')}`,
    ...kmsParams()
  }));
  await removeObject(pendingKey);
}

// A pre-signed POST form: S3 enforces the size range and the content type itself.
async function uploadForm(key, contentType) {
  const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
  const Conditions = [
    ['content-length-range', 1, MAX_BYTES],
    ['eq', '$Content-Type', contentType]
  ];
  const Fields = { 'Content-Type': contentType };
  if (kmsKey()) {
    Fields['x-amz-server-side-encryption'] = 'aws:kms';
    Fields['x-amz-server-side-encryption-aws-kms-key-id'] = kmsKey();
    Conditions.push(['eq', '$x-amz-server-side-encryption', 'aws:kms']);
    Conditions.push(['eq', '$x-amz-server-side-encryption-aws-kms-key-id', kmsKey()]);
  }
  const { url, fields } = await createPresignedPost(getClients().signer, {
    Bucket: process.env.RECEIPTS_BUCKET, Key: key, Conditions, Fields, Expires: URL_TTL_SEC
  });
  return { url, fields };
}

// Which file type do these first bytes really belong to? ("magic numbers")
function sniffType(bytes) {
  const b = bytes || [];
  const starts = (...sig) => sig.every((v, i) => b[i] === v);
  if (starts(0xFF, 0xD8, 0xFF)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) return 'image/png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2D)) return 'application/pdf'; // "%PDF-"
  return null;
}

// Read only the first 8 bytes of the uploaded file (enough to recognise the type)
async function readStart(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await getClients().s3.send(new GetObjectCommand({
    Bucket: process.env.RECEIPTS_BUCKET, Key: key, Range: 'bytes=0-7'
  }));
  return Array.from(await res.Body.transformToByteArray());
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

module.exports = { enabled, kmsKey, keyFor, pendingKeyFor, promote, uploadForm, sniffType, readStart, downloadUrl, removeObject, URL_TTL_SEC, MAX_BYTES, TYPES };
