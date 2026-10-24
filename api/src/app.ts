// Azure Functions v4 アプリケーションエントリーポイント
// すべての関数をここでimportして登録

// 関数をimportすることで、app.http・app.storageQueue の登録が実行される
import './functions/catalogEntries';
import './functions/catalogEntry';
import './functions/catalogKinds';
import './functions/photoDetail';
import './functions/photoMove';
import './functions/photoProcess';
import './functions/photos';
import './functions/processPhoto';
import './functions/requeueStalePhotos';
import './functions/sweepAlbum';
import './functions/timeline';
import './functions/tripDetail';
import './functions/trips';
