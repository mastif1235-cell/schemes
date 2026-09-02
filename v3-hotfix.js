/* Blocknot Scan v3.2.1 hotfix: keep the normal photo sheet stable. */
const v321PhotoFromImageBase = v3PhotoFromImage;
v3PhotoFromImage = async function(img) {
  if (img && img.closest && img.closest('#v321RegularViewer')) return null;
  return v321PhotoFromImageBase(img);
};

const v321OpenRegularPhotoBase = v321OpenRegularPhoto;
v321OpenRegularPhoto = async function(photo) {
  const result = await v321OpenRegularPhotoBase(photo);
  const root = document.getElementById('v321RegularViewer');
  if (root && photo) root.dataset.photoId = photo.id;
  return result;
};

const v321RefreshPhotoBadgesBase = v321RefreshPhotoBadges;
v321RefreshPhotoBadges = async function() {
  await v321RefreshPhotoBadgesBase();
  const root = document.getElementById('v321RegularViewer');
  const status = document.getElementById('v321RegularStatus');
  const id = root && root.dataset ? root.dataset.photoId : null;
  if (status && id) {
    const photo = await get('photos', id);
    if (photo) status.textContent = await v321PhotoStatusText(photo);
  }
};
