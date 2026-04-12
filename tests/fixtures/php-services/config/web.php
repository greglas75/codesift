<?php
return [
    'components' => [
        'db' => [
            'class' => 'yii\db\Connection',
            'dsn' => 'mysql:host=localhost;dbname=test',
        ],
        'user' => [
            'class' => 'app\components\UserComponent',
            'identityClass' => 'app\models\User',
        ],
        'mailer' => [
            'class' => 'app\components\Mailer',
            'useFileTransport' => true,
        ],
    ],
];
