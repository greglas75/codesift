<?php
return [
    'modules' => [
        'api' => ['class' => 'app\\modules\\api\\Module'],
        'manage' => ['class' => 'app\\modules\\manage\\Module'],
    ],
    'components' => [
        'urlManager' => [
            'enablePrettyUrl' => true,
            'rules' => [
                'GET api/users/<id>' => 'api/user/view',
                'POST api/users' => 'api/user/create',
                'manage/dashboard' => 'manage/dashboard/index',
            ],
        ],
    ],
];
