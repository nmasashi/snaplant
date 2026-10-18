// Azure Functions v4 アプリケーションエントリーポイント
// すべての関数をここでimportして登録

// 関数をimportすることで、app.http・app.storageQueue の登録が実行される
import './functions/catalogEntries';
import './functions/catalogEntry';
import './functions/catalogKinds';
import './functions/checkDuplicate';
import './functions/identify';
import './functions/photoDetail';
import './functions/photoMove';
import './functions/photoProcess';
import './functions/photos';
import './functions/plantDetail';
import './functions/plants';
import './functions/processPhoto';
import './functions/requeueStalePhotos';
import './functions/save';
import './functions/sweepAlbum';
import './functions/tripDetail';
import './functions/trips';
import './functions/updatePlant';
import './functions/upload';