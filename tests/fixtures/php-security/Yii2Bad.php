<?php
namespace app\controllers;

use yii\web\Controller;

/**
 * Trigger surface for the Sprint 2 PHP/Yii2 security patterns. Each method
 * intentionally exercises one or more checks so the test suite can assert
 * on detection — kept in a single file so all rules surface against one
 * fixture without inflating the index.
 */
class Yii2Bad extends Controller
{
    public $enableCsrfValidation = false;            // yii-csrf-disabled

    public function actionMassAssign()
    {
        $model = new SomeModel();
        $model->setAttributes($_POST);                // yii-mass-assignment-unsafe
        $model->save();
    }

    public function actionRawWhere($name)
    {
        return SomeModel::find()->where("name = $name")->all();   // yii-raw-sql-where
    }

    public function actionWeakHash($password)
    {
        $hash = md5($password);                       // php-md5-password
        $other = sha1($password);                     // php-md5-password
    }

    public function actionToken()
    {
        $token = rand(1000, 9999);                    // php-rand-token
        $secret = uniqid();                            // php-rand-token
        return [$token, $secret];
    }

    public function actionCompare($expected_hash)
    {
        $hash = $_GET['h'] ?? '';
        if ($hash == $expected_hash) {                // php-loose-comparison-secret
            return 'ok';
        }
        return 'no';
    }

    public function actionRbacInLoop($users)
    {
        $allowed = [];
        foreach ($users as $u) {
            if (\Yii::$app->user->can('viewProfile')) { // yii-rbac-cached-permission
                $allowed[] = $u;
            }
        }
        return $allowed;
    }

    public function actionTransfer($fromId, $toId, $amount)
    {
        $tx = \Yii::$app->db->beginTransaction();      // yii-no-row-level-locking
        $from = Account::findOne($fromId);
        $from->balance -= $amount;
        $from->save();
        $tx->commit();
    }
}
