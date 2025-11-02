const axios = require('axios');
const base = 'https://hrpayrollmanagementsystembackend.onrender.com';

async function runTests() {
  const results = [];
  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e.response?.data || e.message });
    }
  }

  let admin, token, emailHeader;

  await test('Server Health', async () => {
    const r = await axios.get(base + '/');
    if (!r.data.ok) throw 'Server unhealthy';
  });

  await test('Admin Login', async () => {
    const r = await axios.post(base + '/auth/login', {
      email: 'admin@pavakie.com',
      password: 'admin123',
    });
    if (!r.data.ok) throw 'Login failed';
    admin = r.data.user;
    emailHeader = { 'x-user-email': admin.email };
  });

  await test('Get Employees', async () => {
    const r = await axios.get(base + '/employees', { headers: emailHeader });
    if (!r.data.ok) throw 'Fetch failed';
  });

  await test('Mark Attendance', async () => {
    const r = await axios.post(
      base + '/attendance',
      { employee: admin._id, date: new Date(), status: 'present' },
      { headers: emailHeader }
    );
    if (!r.data.ok) throw 'Attendance insert failed';
  });

  await test('Generate Salary Slip JSON', async () => {
    const today = new Date();
    const r = await axios.get(
      base +
        `/salary/generate?employeeId=${admin._id}&month=${
          today.getMonth() + 1
        }&year=${today.getFullYear()}`,
      { headers: emailHeader }
    );
    if (!r.data.ok) throw 'Salary slip gen failed';
  });

  await test('Generate Salary PDF', async () => {
    const today = new Date();
    const r = await axios.get(
      base +
        `/salary/pdf?employeeId=${admin._id}&month=${
          today.getMonth() + 1
        }&year=${today.getFullYear()}`,
      { headers: emailHeader, responseType: 'arraybuffer' }
    );
    if (r.headers['content-type'] !== 'application/pdf')
      throw 'PDF not received';
  });

  console.log('\n=== TEST REPORT ===');
  results.forEach((r) => {
    console.log(
      `${r.ok ? '✅' : '❌'} ${r.name}${
        r.ok ? '' : ': ' + JSON.stringify(r.error)
      }`
    );
  });
  const passed = results.filter((x) => x.ok).length;
  console.log(`\n${passed}/${results.length} tests passed.`);
}

runTests();
