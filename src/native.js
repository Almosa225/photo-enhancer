import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Media } from '@capacitor-community/media';

const ALBUM = 'Photo Enhancer';

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function getAlbumId() {
  let { albums } = await Media.getAlbums();
  let a = albums.find(x => x.name === ALBUM);
  if (!a) {
    await Media.createAlbum({ name: ALBUM });
    ({ albums } = await Media.getAlbums());
    a = albums.find(x => x.name === ALBUM);
  }
  return a && a.identifier;
}

async function writeTemp(blob, name) {
  const data = await blobToBase64(blob);
  const r = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
  return r.uri;
}

window.NativeApp = {
  isNative: () => Capacitor.isNativePlatform(),
  // save to the phone gallery; returns true on success
  async saveToGallery(blob, baseName) {
    const uri = await writeTemp(blob, baseName + '.jpg');
    const albumIdentifier = await getAlbumId();
    await Media.savePhoto({ path: uri, albumIdentifier, fileName: baseName });
    try { await Filesystem.deleteFile({ path: baseName + '.jpg', directory: Directory.Cache }); } catch (e) {}
    return true;
  },
  async share(blob, baseName) {
    const uri = await writeTemp(blob, baseName + '.jpg');
    await Share.share({ files: [uri] });
  }
};
