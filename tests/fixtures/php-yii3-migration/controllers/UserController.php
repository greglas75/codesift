<?php
namespace app\controllers;

use Yii;
use yii\web\Controller;

class UserController extends Controller
{
    public function actionView($id)
    {
        $user = Yii::$app->user->identity;
        $db = Yii::$app->db;
        $logger = Yii::$app->log;

        Yii::info("Viewing user $id", __METHOD__);
        Yii::error("Something failed", __METHOD__);

        $cache = Yii::$app->cache;
        $mailer = Yii::$app->mailer;

        if (!Yii::$app->user->can('viewUser')) {
            Yii::$app->response->statusCode = 403;
            return $this->render('forbidden');
        }

        $name = Yii::$app->name;
        $params = Yii::$app->params;
        $homeUrl = Yii::$app->homeUrl;

        $request = Yii::$app->request->post();
        $session = Yii::$app->session;

        $url = Yii::$app->urlManager->createUrl(['user/view', 'id' => $id]);
        Yii::$app->session->setFlash('success', Yii::t('app', 'User loaded'));

        $this->layout = '@app/views/layouts/main';
        return $this->render('view', ['user' => $user]);
    }

    public function actionCreate()
    {
        $factoryInstance = Yii::createObject(['class' => 'app\\models\\Factory']);
        $alias = Yii::getAlias('@app/runtime');
        return $this->render('create');
    }
}
