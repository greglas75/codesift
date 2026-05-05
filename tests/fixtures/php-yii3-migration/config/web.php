<?php
return [
    'urlManager' => [
        'enablePrettyUrl' => true,
        'rules' => [
            'GET api/users/<id>' => 'user/view',
        ],
    ],
    'components' => [
        'db' => ['class' => 'yii\\db\\Connection'],
    ],
];
