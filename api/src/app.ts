// Azure Functions v4 アプリケーションエントリーポイント
// すべての関数をここでimportして登録

// 関数をimportすることで、app.httpの登録が実行される
import './functions/checkDuplicate';
import './functions/identify';
import './functions/plantDetail';
import './functions/plants';
import './functions/save';
import './functions/updatePlant';
import './functions/upload';