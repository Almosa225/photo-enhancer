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
  // write in chunks so big videos don't need one giant base64 string in memory
  const CHUNK = 3 * 1024 * 1024; // multiple of 3 keeps base64 chunks independent
  let uri = null;
  for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
    const data = await blobToBase64(blob.slice(off, off + CHUNK));
    if (off === 0) uri = (await Filesystem.writeFile({ path: name, data, directory: Directory.Cache })).uri;
    else await Filesystem.appendFile({ path: name, data, directory: Directory.Cache });
    if (blob.size === 0) break;
  }
  return uri;
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
  async saveVideoToGallery(blob, baseName, ext) {
    const fname = baseName + '.' + (ext || 'mp4');
    const uri = await writeTemp(blob, fname);
    const albumIdentifier = await getAlbumId();
    await Media.saveVideo({ path: uri, albumIdentifier, fileName: baseName });
    try { await Filesystem.deleteFile({ path: fname, directory: Directory.Cache }); } catch (e) {}
    return true;
  },
  async shareFile(blob, fname) {
    const uri = await writeTemp(blob, fname);
    await Share.share({ files: [uri] });
  },
  async share(blob, baseName) {
    const uri = await writeTemp(blob, baseName + '.jpg');
    await Share.share({ files: [uri] });
  }
};
