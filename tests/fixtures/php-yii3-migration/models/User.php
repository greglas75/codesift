<?php
namespace app\models;

use yii\db\ActiveRecord;
use yii\base\Model;

class User extends ActiveRecord
{
    public static function tableName()
    {
        return 'user';
    }

    public function rules(): array
    {
        return [
            ['email', 'required'],
            ['email', 'email'],
        ];
    }
}

class LoginForm extends Model
{
    public $email;
    public $password;

    public function rules()
    {
        return [
            [['email', 'password'], 'required'],
        ];
    }

    public function login()
    {
        return $this->load(\Yii::$app->request->post()) && $this->validate();
    }
}
