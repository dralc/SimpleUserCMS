import avaTest, { TestInterface } from 'ava';  // NB. ava 3.x needs latest nodejs 10, 12, 13
import * as http from 'http';
import sinon from 'sinon';
import { factory }from '../graphql/appGraphql';
import { DataNotFoundError } from '../datasource/DatasourceErrors';
import { hasSameProps, getFuncPerf } from '../utils';
import nodeFetch from 'node-fetch';
import { callGql } from '../src/utils';
import { QUERY_user, QUERY_userList, MUTATION_createUser, MUTATION_removeUser } from "./gqlQueries";
import { ValidationError } from "./errors";

/**
 * Inject a fetch API compliant function to use
 */
let request = async (url, query, vars) => {
	// @ts-ignore
	return await callGql(url, query, vars, { fetch: nodeFetch });
};
const testListen = require('test-listen');
const test = avaTest as TestInterface<{ testProps, ds_get, ds_getUsers, server, serverUrl:string }>;
let isStubDatasource = !!process.env.SIM_STUB_DATASOURCE;

function stubApp(ctx) {
	const id = 'patrickId';
	const badName = ctx.testProps.badName;
	const goodName = ctx.testProps.goodName;
	const stubDs = {
		get: sinon.stub(),
		getUsers: sinon.stub(),
		add: sinon.stub(),
		remove: sinon.stub(),
	};

	stubDs.get.withArgs({ name: badName })
		.throws(new DataNotFoundError( { input: badName } ));
	stubDs.get.withArgs({ name: goodName })
		.resolves( { id, name:'', email:'', address:'', role:false } );
	
	stubDs.getUsers.withArgs( { name: badName } )
		.throws(new DataNotFoundError( { input: badName } ));
	stubDs.getUsers.withArgs( { name: goodName } )
		.resolves( (new Array(47)).fill( { id, name:'', email:'', address:'', role:false } ));

	stubDs.add.withArgs( ctx.testProps.validUser )
		.resolves( { id: ctx.testProps.validUserId } );

	stubDs.remove.withArgs( ctx.testProps.validUserId )
		.resolves(`Removed ${ctx.testProps.validUserId}`);

	return factory(stubDs);
}

test.beforeEach(async t => {
	t.context.testProps = {
		badName: 'bad name here',
		goodName: 'Patrick',
		validUserId: 'userId:987123',
		validUser: {
			name: 'Alverta Lang',
			address: '51405 Zemlak Viaduct, Lake Alex 08214',
			email: 'Tillman.Rice@yahoo.com',
			role: true,
		},
	};	

	// Instrument graphql server
	let app;
	if (isStubDatasource) {
		app = stubApp(t.context);
	} else {
		app = factory();
	}

	t.context.server = http.createServer(app);
	const serverUrl = await testListen(t.context.server);
	t.context.serverUrl = `${serverUrl}${process.env.SIM_GQL_PATH}`;
});

test.afterEach.always(t => {
	sinon.restore();
	t.context.server.close();
});

test('Get a user', async t => {
	try {
		const ctx = t.context;

		// Test an invalid 'name'
		let err = await t.throwsAsync( () => {
			return request(ctx.serverUrl, QUERY_user, { name: ctx.testProps.badName });
		}, null, 'should have thrown bad input error');

		let err_o = JSON.parse(err.message);
		t.is(err_o.errors[0].extensions.code, 'BAD_USER_INPUT');

		// Test a valid 'name'
		let payload = await request(ctx.serverUrl, QUERY_user, { name: ctx.testProps.goodName });
		t.truthy(payload.data.user.id, 'a user should have been found');
	}
	catch (er) {
		t.fail(er.message);
		t.log(er.stack);
	}
});

test('Get a list of users | invalid name', async t => {
	try {
		const ctx = t.context;
		const err = await t.throwsAsync(() => {
			return request(ctx.serverUrl, QUERY_userList, { name: ctx.testProps.badName } )
		}, null, 'should have thrown bad input error');

		let err_o = JSON.parse(err.message);
		t.is(err_o.errors[0].extensions.code, 'BAD_USER_INPUT');
	}
	catch (er) {
		t.fail(er.message);
		t.log(er.stack);
	}
});

test('Get a list of users | valid name', async t => {
	try {
		const ctx = t.context;
		const users = await request(ctx.serverUrl, QUERY_userList, { name: ctx.testProps.goodName, first: 15 } );
		t.is(users.data.userList.length, 15);
		t.true(hasSameProps( users.data.userList[0], { id:'',name:'',email:'',address:'',role:'' } ));
	}
	catch (er) {
		t.fail(er.message);
		t.log(er.stack);
	}
})

test('Create a user: invalid user', async t => {
	try {

		const ctx = t.context;
		const invalidUser = { /* no input fields specified */ };
		let res = await t.throwsAsync( () => {
			return request(ctx.serverUrl, MUTATION_createUser, invalidUser);
		}, null, 'should have thrown validation error') as ValidationError;
		
		let err_o = JSON.parse(res.message);
		t.is(err_o.errors.length, 4, 'should have the right no. of validation errors');
	}
	catch (er) {
		t.fail(er.message);
		t.log(er.stack);
	}
});

test('Create a valid user, then remove it ', async t => {
	try {
		const ctx = t.context;
		const validUser = ctx.testProps.validUser;
		let res = await request(ctx.serverUrl, MUTATION_createUser, validUser);
		t.true(res.data.createUser.success);
		t.true(hasSameProps(res.data.createUser.user, { id:'', name:'', email:'', address:'', role:'' }));
		t.truthy(res.data.createUser.user.id);

		// Test removing the added user
		res = await request(ctx.serverUrl, MUTATION_removeUser, { id: res.data.createUser.user.id } );
		t.true(res.data.removeUser.success);
	}
	catch (er) {
		t.fail(er.message);
		t.log(er.stack);
	}
});

test('Response time - QUERY_userList', async t => {
	const pad = 20;
	const avg_time_max = { local: 100 + pad, ci: 100 + pad };

	let perf = await getFuncPerf(3, () => request(t.context.serverUrl, QUERY_userList, { name: 'Patrick' }));

	t.log('Users found    :', perf.response.data.userList.length);
	t.log('Durations (ms) :', perf.durations);
	t.log('Average (ms)   :', perf.avg);

	t.truthy(perf.avg < (process.env.CI ? avg_time_max.ci : avg_time_max.local), `Average (${perf.avg}) is too high`);
});
