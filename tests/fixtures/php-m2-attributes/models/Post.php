<?php
namespace app\models;

use yii\behaviors\TimestampBehavior;
use yii\behaviors\BlameableBehavior;
use yii\db\ActiveRecord;

class Post extends ActiveRecord
{
    public function behaviors()
    {
        return [
            'timestamp' => TimestampBehavior::class,
            'blameable' => [
                'class' => BlameableBehavior::class,
                'createdByAttribute' => 'author_id',
            ],
        ];
    }

    public function rules()
    {
        return [
            [['title', 'body'], 'required'],
            ['title', 'string', 'max' => 200],
            ['author_email', 'email'],
            [['author_email'], 'unique'],
        ];
    }
}
